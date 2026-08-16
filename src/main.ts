import { Notice, Platform, Plugin, SuggestModal, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, KindleStkSettings, KindleStkSettingTab } from './settings';
import { extractNote } from './obsidian-extract/extract';
import { buildEpub } from './epub/builder';
import { createTempEpubFile } from './epub/temp';
import { generatePkce } from './stk/oauth';
import { OperationTracker } from './lifecycle';
import {
	disconnectCredentials,
	migrateLegacyCredentials,
	readCredentials,
	writeCredentials,
	type StkCredentials,
} from './stk/credentials';
import {
	isAllowedOAuthNavigation,
	isRedirectUrl,
	parseAuthorizationCode,
} from './stk/redirect';
import {
	buildAmazonAuthUrl,
	listOwnedDevices,
	registerDevice,
	sendToKindle,
	type OwnedDevice,
} from './stk/client';

type SendDestinationOption = {
	label: string;
	description: string;
	serials: string[];
	isDefault: boolean;
};

type BeforeRequestDetails = { url: string };
type BeforeRequestResponse = { cancel: boolean };
type WebContents = {
	on: (event: string, cb: (...args: unknown[]) => void) => void;
	session: {
		webRequest: {
			onBeforeRequest: (
				filter: { urls: string[] },
				cb: (
					details: BeforeRequestDetails,
					callback: (response: BeforeRequestResponse) => void,
				) => void,
			) => void;
		};
	};
	setWindowOpenHandler?: (handler: (details: unknown) => { action: 'deny' }) => void;
	loadURL: (url: string) => Promise<void>;
};
type StkWindow = {
	webContents: WebContents;
	on: (event: string, cb: () => void) => void;
	removeAllListeners: (event: string) => void;
	close: () => void;
};
type RemoteModule = {
	BrowserWindow: new (opts: Record<string, unknown>) => StkWindow;
};

// Rejected when the OAuth flow is cancelled (plugin unload or disconnect).
// Callers treat it as an expected abort: no notice, no further work.
class OAuthFlowCancelledError extends Error {
	constructor() {
		super('OAuth flow cancelled');
		this.name = 'OAuthFlowCancelledError';
	}
}

class SendDestinationModal extends SuggestModal<SendDestinationOption> {
	private resolveChoice: (value: SendDestinationOption | null) => void;
	private options: SendDestinationOption[];
	private didChoose = false;

	constructor(plugin: KindleStkPlugin, options: SendDestinationOption[]) {
		super(plugin.app);
		this.options = options;
		this.resolveChoice = () => void 0;
		this.setPlaceholder('Choose where to send this note');
	}

	choose(): Promise<SendDestinationOption | null> {
		return new Promise((resolve) => {
			this.resolveChoice = resolve;
			this.open();
		});
	}

	getSuggestions(query: string): SendDestinationOption[] {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return this.options;
		return this.options.filter((option) =>
			`${option.label} ${option.description}`.toLowerCase().includes(normalized),
		);
	}

	renderSuggestion(option: SendDestinationOption, el: HTMLElement): void {
		el.createDiv({ text: option.isDefault ? `${option.label} (Default)` : option.label });
		el.createEl('small', { text: option.description });
	}

	onChooseSuggestion(option: SendDestinationOption): void {
		this.didChoose = true;
		this.resolveChoice(option);
	}

	onClose(): void {
		super.onClose();
		if (!this.didChoose) this.resolveChoice(null);
	}
}

export default class KindleStkPlugin extends Plugin {
	settings!: KindleStkSettings;
	private authWindow: StkWindow | null = null;
	private auth = new OperationTracker();
	private authTimeoutId: number | null = null;
	private cancelActiveAuth: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		if (migrateLegacyCredentials(this.app.secretStorage)) {
			new Notice('Migrated stored Send to Kindle credentials to the new secure key.');
		}

		this.addCommand({
			id: 'send-note',
			name: 'Send current note to Kindle',
			editorCallback: (_editor, view) => {
				if (view.file) void this.sendToKindle(view.file);
			},
		});

		this.addCommand({
			id: 'authenticate-amazon',
			name: 'Authenticate with Amazon',
			callback: () => void this.startOAuthFlow(),
		});

		this.addSettingTab(new KindleStkSettingTab(this.app, this));
	}

	onunload(): void {
		this.cancelOAuth();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<KindleStkSettings>,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	isAuthenticated(): boolean {
		return this.getCredentials() !== null;
	}

	private getCredentials(): StkCredentials | null {
		return readCredentials(this.app.secretStorage);
	}

	private storeCredentials(creds: StkCredentials): void {
		writeCredentials(this.app.secretStorage, creds);
	}

	async disconnect(): Promise<void> {
		this.cancelOAuth();
		disconnectCredentials(this.app.secretStorage);
		this.settings.lastDeviceSerial = null;
		await this.saveSettings();
	}

	getAuthenticatedAccountLabel(): string | null {
		const creds = this.getCredentials();
		if (!creds) return null;
		return creds.accountName ?? creds.registeredDeviceName ?? null;
	}

	async getOwnedDevicesForUi(): Promise<OwnedDevice[]> {
		const creds = this.getCredentials();
		if (!creds) return [];
		return listOwnedDevices(creds);
	}

	async getOwnedDevicesStatus(): Promise<{ devices: OwnedDevice[]; error: string | null }> {
		const creds = this.getCredentials();
		if (!creds) return { devices: [], error: null };
		try {
			return { devices: await listOwnedDevices(creds), error: null };
		} catch (err) {
			return { devices: [], error: (err as Error).message };
		}
	}

	async startOAuthFlow(): Promise<void> {
		if (this.auth.inProgress || this.authWindow) {
			new Notice('Authentication is already in progress.');
			return;
		}
		if (!Platform.isDesktopApp) {
			new Notice('Authentication requires the desktop version of Obsidian.');
			return;
		}

		const w = window as unknown as { require?: (mod: string) => unknown };
		const req = w.require;
		if (!req) {
			new Notice('Electron runtime not available.');
			return;
		}

		let remote: RemoteModule | null = null;
		try {
			const e = req('electron') as { remote?: RemoteModule };
			if (e.remote?.BrowserWindow) remote = e.remote;
		} catch { /* Electron remote module absent */ }
		if (!remote) {
			try {
				const r = req('@electron/remote') as RemoteModule;
				if (r.BrowserWindow) remote = r;
			} catch { /* Electron remote module absent */ }
		}
		if (!remote) {
			new Notice('Could not access electron browserwindow in this Obsidian build.');
			return;
		}

		const generation = this.auth.begin();

		try {
			let pkce: Awaited<ReturnType<typeof generatePkce>>;
			let authUrl: string;
			try {
				pkce = await generatePkce();
				authUrl = buildAmazonAuthUrl(pkce);
			} catch (err) {
				if (!this.auth.isCurrent(generation)) return;
				const msg = err instanceof Error ? err.message : 'Could not prepare the authentication request';
				new Notice('Authentication cancelled: ' + msg);
				return;
			}
			if (!this.auth.isCurrent(generation)) return;

			let authCode: string;
			try {
				authCode = await this.openOAuthWindow(remote, authUrl, generation);
			} catch (err) {
				if (err instanceof OAuthFlowCancelledError || !this.auth.isCurrent(generation)) return;
				const msg = err instanceof Error ? err.message : 'Authentication was cancelled';
				new Notice('Authentication cancelled: ' + msg);
				return;
			}
			if (!this.auth.isCurrent(generation)) return;

			let creds: StkCredentials;
			try {
				creds = await registerDevice(authCode, pkce.verifier);
			} catch (err) {
				console.error('STK registerDevice failed', err);
				if (!this.auth.isCurrent(generation)) return;
				new Notice('Authentication failed during device registration. Check the console for details.');
				return;
			}
			if (!this.auth.isCurrent(generation)) return;

			this.storeCredentials(creds);

			try {
				const devices = await listOwnedDevices(creds);
				if (!this.auth.isCurrent(generation)) return;
				if (this.settings.lastDeviceSerial && !devices.some((device) => device.serialNumber === this.settings.lastDeviceSerial)) {
					this.settings.lastDeviceSerial = null;
					await this.saveSettings();
				}
				new Notice('Authenticated successfully. Found ' + devices.length + ' Kindle device(s).');
			} catch (err) {
				console.error('STK listOwnedDevices failed', err);
				if (!this.auth.isCurrent(generation)) return;
				new Notice('Authentication succeeded, but the device list could not be loaded.');
			}
		} finally {
			this.auth.finish(generation);
		}
	}

	/**
	 * Opens the sandboxed Electron window and resolves with the authorization
	 * code only once the strictly validated Amazon redirect is captured. The
	 * window is hardened: `window.open` is denied outright and top-level
	 * navigation is limited to HTTPS on the exact Amazon login hosts — any
	 * external navigation is prevented, rejects the promise with a sanitized
	 * error and closes the window through the same settle path. Cancelling
	 * (via {@link cancelOAuth}) rejects the promise with
	 * {@link OAuthFlowCancelledError} after closing the window.
	 */
	private openOAuthWindow(
		remote: RemoteModule,
		authUrl: string,
		generation: number,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const partition = `stk-oauth-${Date.now()}-${generation}`;
			const win = new remote.BrowserWindow({
				width: 500,
				height: 730,
				show: true,
				title: 'Authenticate with Amazon',
				webPreferences: {
					nodeIntegration: false,
					contextIsolation: true,
					sandbox: true,
					partition,
				},
			});
			this.authWindow = win;

			let settled = false;
			const done = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				this.clearAuthTimeout();
				if (this.authWindow === win) this.authWindow = null;
				this.cancelActiveAuth = null;
				try {
					win.removeAllListeners('closed');
					win.close();
				} catch { /* Window may already be destroyed */ }
				fn();
			};

			const checkUrl = (url: string): boolean => {
				if (settled) return false;
				if (!isRedirectUrl(url)) return false;
				try {
					const code = parseAuthorizationCode(url);
					done(() => resolve(code));
				} catch (err) {
					done(() => reject(err instanceof Error ? err : new Error('Invalid authorization redirect')));
				}
				return true;
			};

			if (typeof win.webContents.setWindowOpenHandler === 'function') {
				win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
			}

			win.webContents.on('will-navigate', (...args: unknown[]) => {
				const [event, url] = args as [unknown, string];
				if (isAllowedOAuthNavigation(url)) return;
				(event as { preventDefault: () => void }).preventDefault();
				done(() => reject(new Error('Authentication navigation was blocked')));
			});

			win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
				const matched = checkUrl(details.url);
				callback({ cancel: matched });
			});
			win.webContents.on('will-redirect', (...args: unknown[]) => {
				const [event, url] = args as [unknown, string];
				if (checkUrl(url)) (event as { preventDefault: () => void }).preventDefault();
			});
			win.webContents.on('did-navigate', (...args: unknown[]) => {
				const [, url] = args as [unknown, string];
				checkUrl(url);
			});
			win.webContents.on('did-redirect-navigation', (...args: unknown[]) => {
				const [, url] = args as [unknown, string];
				checkUrl(url);
			});
			win.webContents.on('did-navigate-in-page', (...args: unknown[]) => {
				const [, url] = args as [unknown, string];
				checkUrl(url);
			});
			win.webContents.on('did-fail-load', (...args: unknown[]) => {
				const [, errorCode, , url] = args as [unknown, number, string, string];
				if (errorCode === -3 && isRedirectUrl(url)) checkUrl(url);
			});

			win.on('closed', () => {
				this.clearAuthTimeout();
				if (this.authWindow === win) this.authWindow = null;
				this.cancelActiveAuth = null;
				if (!settled) {
					settled = true;
					reject(new Error('Authentication window closed'));
				}
			});

			this.cancelActiveAuth = () => {
				this.clearAuthTimeout();
				if (this.authWindow === win) this.authWindow = null;
				this.cancelActiveAuth = null;
				if (settled) {
					try {
						win.removeAllListeners('closed');
						win.close();
					} catch { /* Window may already be destroyed */ }
					return;
				}
				settled = true;
				try {
					win.removeAllListeners('closed');
					win.close();
				} catch { /* Window may already be destroyed */ }
				reject(new OAuthFlowCancelledError());
			};

			void win.webContents.loadURL(authUrl).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				if (/ERR_ABORTED/.test(msg)) return;
				done(() => reject(new Error(`Failed to load auth URL: ${msg}`)));
			});

			this.authTimeoutId = window.setTimeout(() => {
				if (!settled) done(() => reject(new Error('OAuth flow timed out after 5 minutes')));
			}, 5 * 60 * 1000);
		});
	}

	/** Single cancellation path shared by `onunload()` and `disconnect()`. */
	private cancelOAuth(): void {
		this.auth.cancel();
		this.clearAuthTimeout();
		const cancel = this.cancelActiveAuth;
		this.cancelActiveAuth = null;
		if (cancel) {
			cancel();
			return;
		}
		const win = this.authWindow;
		this.authWindow = null;
		if (win) {
			try {
				win.removeAllListeners('closed');
				win.close();
			} catch { /* Window may already be destroyed */ }
		}
	}

	private clearAuthTimeout(): void {
		if (this.authTimeoutId !== null) {
			window.clearTimeout(this.authTimeoutId);
			this.authTimeoutId = null;
		}
	}

	private async sendToKindle(file: TFile): Promise<void> {
		const creds = this.getCredentials();
		if (!creds) {
			new Notice('Not authenticated. Run "authenticate with Amazon" first.');
			return;
		}

		let devices: OwnedDevice[];
		try {
			devices = await listOwnedDevices(creds);
		} catch (err) {
			new Notice('Failed to list Kindle devices: ' + (err as Error).message);
			return;
		}

		const targetSerials = await this.chooseTargetSerials(devices);
		if (targetSerials === null) {
			new Notice('Send cancelled.');
			return;
		}

		try {
			new Notice('Preparing note...');
			const note = await extractNote(this.app, file);
			const epub = await buildEpub(note, {
				title: note.title,
				author: this.settings.defaultAuthor,
			});
			const tempFile = createTempEpubFile(Buffer.from(epub));

			try {
				new Notice('Sending to Kindle...');
				await sendToKindle(creds, {
					filePath: tempFile.path,
					title: note.title,
					author: this.settings.defaultAuthor,
					format: 'EPUB',
					targetSerials,
				});

				new Notice(`"${note.title}" sent to Kindle.`);
			} finally {
				tempFile.cleanup();
			}
		} catch (err) {
			new Notice('Failed to send: ' + (err as Error).message);
			console.error('STK send failed', err);
		}
	}

	private async chooseTargetSerials(devices: OwnedDevice[]): Promise<string[] | null> {
		if (
			this.settings.lastDeviceSerial
			&& !devices.some((device) => device.serialNumber === this.settings.lastDeviceSerial)
		) {
			this.settings.lastDeviceSerial = null;
			await this.saveSettings();
		}

		if (!this.settings.promptForDeviceOnSend && this.settings.lastDeviceSerial) {
			return [this.settings.lastDeviceSerial];
		}
		if (!this.settings.promptForDeviceOnSend && this.settings.lastDeviceSerial === null) {
			return [];
		}

		const options: SendDestinationOption[] = [
			{
				label: 'Send to Kindle library',
				description: 'Deliver to your cloud library without picking one specific device.',
				serials: [],
				isDefault: this.settings.lastDeviceSerial === null,
			},
			...devices.map((device) => ({
				label: device.deviceName,
				description: device.serialNumber,
				serials: [device.serialNumber],
				isDefault: this.settings.lastDeviceSerial === device.serialNumber,
			})),
		];

		const orderedOptions = options.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
		const choice = await new SendDestinationModal(this, orderedOptions).choose();
		return choice?.serials ?? null;
	}
}
