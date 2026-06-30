import { Notice, Platform, Plugin, SuggestModal, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, KindleStkSettings, KindleStkSettingTab } from './settings';
import { extractNote } from './obsidian-extract/extract';
import { buildEpub } from './epub/builder';
import { generatePkce } from './stk/oauth';
import {
	buildAmazonAuthUrl,
	listOwnedDevices,
	registerDevice,
	sendToKindle,
	type OwnedDevice,
	type StkCredentials,
} from './stk/client';
import type os from 'os';
import type fs from 'fs';
import type path from 'path';

const nodeOs = window.require('os') as typeof os;
const nodeFs = window.require('fs') as typeof fs;
const nodePath = window.require('path') as typeof path;

const SECRET_KEY = 'stk-credentials';

type SendDestinationOption = {
	label: string;
	description: string;
	serials: string[];
	isDefault: boolean;
};

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

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: 'send-to-kindle',
			name: 'Send current note to kindle',
			editorCallback: (_editor, view) => {
				if (view.file) void this.sendToKindle(view.file);
			},
		});

		this.addCommand({
			id: 'authenticate-amazon',
			name: 'Authenticate with amazon',
			callback: () => void this.startOAuthFlow(),
		});

		this.addSettingTab(new KindleStkSettingTab(this.app, this));
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
		const raw = this.app.secretStorage.getSecret(SECRET_KEY);
		if (!raw) return null;
		try {
			return JSON.parse(raw) as StkCredentials;
		} catch {
			return null;
		}
	}

	private storeCredentials(creds: StkCredentials): void {
		this.app.secretStorage.setSecret(SECRET_KEY, JSON.stringify(creds));
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
		if (!Platform.isDesktopApp) {
			new Notice('Authentication requires the desktop version of Obsidian.');
			return;
		}

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
		} catch { void 0; }
		if (!remote) {
			try {
				const r = req('@electron/remote') as RemoteModule;
				if (r.BrowserWindow) remote = r;
			} catch { void 0; }
		}
		if (!remote) {
			new Notice('Could not access electron browserwindow in this Obsidian build.');
			return;
		}

		const pkce = await generatePkce();
		const authUrl = buildAmazonAuthUrl(pkce);

		const authCode = await new Promise<string>((resolve, reject) => {
			const partition = `stk-oauth-${Date.now()}`;
			const win = new remote.BrowserWindow({
				width: 500,
				height: 730,
				show: true,
				title: 'Authenticate with Amazon',
				webPreferences: {
					nodeIntegration: false,
					contextIsolation: true,
					partition,
				},
			});

			let settled = false;
			const extractCode = (url: string): string | null => {
				if (!url.includes('openid.oa2.authorization_code=')) return null;
				try {
					return new URL(url).searchParams.get('openid.oa2.authorization_code');
				} catch {
					return null;
				}
			};
			const done = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				try { win.removeAllListeners('closed'); win.close(); } catch { void 0; }
				fn();
			};

			const checkUrl = (url: string): boolean => {
				if (settled) return false;
				const code = extractCode(url);
				if (!code) return false;
				done(() => resolve(code));
				return true;
			};

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
				if (errorCode === -3 || url.includes('openid.oa2.authorization_code=')) checkUrl(url);
			});

			win.on('closed', () => {
				if (!settled) { settled = true; reject(new Error('Authentication window closed')); }
			});

			void win.webContents.loadURL(authUrl).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				if (/ERR_ABORTED/.test(msg)) return;
				if (!settled) { settled = true; reject(new Error(`Failed to load auth URL: ${msg}`)); }
			});

			window.setTimeout(() => {
				if (!settled) done(() => reject(new Error('OAuth flow timed out after 5 minutes')));
			}, 5 * 60 * 1000);
		});

		let creds: StkCredentials;
		try {
			creds = await registerDevice(authCode, pkce.verifier);
			this.storeCredentials(creds);
		} catch (err) {
			new Notice('Authentication failed during device registration: ' + (err as Error).message);
			console.error('STK registerDevice failed', err);
			return;
		}

		try {
			const devices = await listOwnedDevices(creds);
			if (this.settings.lastDeviceSerial && !devices.some((device) => device.serialNumber === this.settings.lastDeviceSerial)) {
				this.settings.lastDeviceSerial = null;
				await this.saveSettings();
			}
			new Notice('Authenticated successfully. Found ' + devices.length + ' Kindle device(s).');
		} catch (err) {
			new Notice('Authentication succeeded, but listing devices failed: ' + (err as Error).message);
			console.error('STK listOwnedDevices failed', err);
		}
	}

	private async sendToKindle(file: TFile): Promise<void> {
		const creds = this.getCredentials();
		if (!creds) {
			new Notice('Not authenticated. Run "authenticate with amazon" first.');
			return;
		}

		let devices: OwnedDevice[];
		try {
			devices = await listOwnedDevices(creds);
		} catch (err) {
			new Notice('Failed to list kindle devices: ' + (err as Error).message);
			return;
		}

		const targetSerials = await this.chooseTargetSerials(devices);
		if (targetSerials === null) {
			new Notice('Send cancelled.');
			return;
		}

		const tempPath = nodePath.join(nodeOs.tmpdir(), `obsidian-kindle-${Date.now()}.epub`);

		try {
			new Notice('Preparing note...');
			const note = await extractNote(this.app, file);
			const epub = await buildEpub(note, {
				title: note.title,
				author: this.settings.defaultAuthor,
			});
			nodeFs.writeFileSync(tempPath, Buffer.from(epub));

			new Notice('Sending to kindle...');
			await sendToKindle(creds, {
				filePath: tempPath,
				title: note.title,
				author: this.settings.defaultAuthor,
				format: 'EPUB',
				targetSerials,
			});

			new Notice(`"${note.title}" sent to Kindle.`);
		} catch (err) {
			new Notice('Failed to send: ' + (err as Error).message);
			console.error('STK send failed', err);
		} finally {
			try {
				nodeFs.unlinkSync(tempPath);
			} catch { void 0; }
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
