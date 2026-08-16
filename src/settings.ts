import { App, Notice, PluginSettingTab, requireApiVersion, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type { OwnedDevice } from './stk/client';
import type KindleStkPlugin from './main';

export interface KindleStkSettings {
	defaultAuthor: string;
	lastDeviceSerial: string | null;
	promptForDeviceOnSend: boolean;
}

export const DEFAULT_SETTINGS: KindleStkSettings = {
	defaultAuthor: 'Obsidian',
	lastDeviceSerial: null,
	promptForDeviceOnSend: true,
};

type AccountState = {
	isAuthenticated: boolean;
	accountLabel: string | null;
};

type DestinationState =
	| { kind: 'not-authenticated' }
	| { kind: 'loading' }
	| { kind: 'error'; error: string }
	| { kind: 'ready'; devices: OwnedDevice[] };

// Row builders shared by the legacy display() render and the declarative
// getSettingDefinitions() render callbacks so both paths stay in sync.

function accountDescription(state: AccountState): string {
	return state.isAuthenticated
		? `Connected${state.accountLabel ? ` as ${state.accountLabel}` : ''}.`
		: 'Not connected. Authenticate to enable sending to your Kindle.';
}

function destinationDescription(state: DestinationState, selectedSerial: string | null): string {
	switch (state.kind) {
		case 'not-authenticated':
			return 'Authenticate first to load your destinations.';
		case 'loading':
			return 'Loading destinations…';
		case 'error':
			return `Could not load destinations: ${state.error}`;
		case 'ready': {
			const selected = state.devices.find(
				(device) => device.serialNumber === selectedSerial,
			);
			return selected
				? `${selected.deviceName} (${selected.serialNumber})`
				: 'Send to Kindle library only.';
		}
	}
}

function buildAccountRow(
	setting: Setting,
	state: AccountState,
	onAuthenticate: () => void,
): void {
	setting
		.setName('Amazon account')
		.setDesc(accountDescription(state))
		.addButton((btn) => {
			btn.setButtonText(
				state.isAuthenticated ? 'Re-authenticate' : 'Authenticate',
			);
			btn.onClick(onAuthenticate);
		});
}

function buildDisconnectRow(setting: Setting, onDisconnect: () => void): void {
	setting
		.setName('Disconnect')
		.setDesc('Removes the saved credentials from this device only. To fully remove the connection, delete the synthetic "Send to Kindle" device from your Amazon account under Content & Devices → Devices.')
		.addButton((btn) => {
			btn.setButtonText('Disconnect');
			btn.setClass('mod-warning');
			btn.onClick(onDisconnect);
		});
}

function buildDestinationRow(
	setting: Setting,
	state: DestinationState,
	selectedSerial: string | null,
	onSelect: (value: string) => void,
	onRefresh: () => void,
): void {
	const isAuthenticated = state.kind !== 'not-authenticated';
	setting
		.setName('Default destination')
		.setDesc(destinationDescription(state, selectedSerial))
		.addDropdown((dropdown) => {
			dropdown.addOption('', 'Send to Kindle library');
			if (state.kind === 'ready') {
				for (const device of state.devices) {
					dropdown.addOption(device.serialNumber, `${device.deviceName} (${device.serialNumber})`);
				}
			}
			dropdown.setValue(selectedSerial ?? '');
			dropdown.setDisabled(state.kind !== 'ready');
			dropdown.onChange(onSelect);
		})
		.addExtraButton((btn) => {
			btn.setIcon('refresh-cw');
			btn.setTooltip('Refresh device list');
			btn.setDisabled(!isAuthenticated);
			btn.onClick(onRefresh);
		});
}

function buildPromptToggleRow(
	setting: Setting,
	value: boolean,
	onChange: (value: boolean) => void,
): void {
	setting
		.setName('Choose destination every time')
		.setDesc('When enabled, every send asks where the note should be delivered.')
		.addToggle((toggle) =>
			toggle
				.setValue(value)
				.onChange(onChange),
		);
}

function buildDefaultAuthorRow(
	setting: Setting,
	value: string,
	onChange: (value: string) => void,
): void {
	setting
		.setName('Default author')
		.setDesc('Used as the author metadata when sending notes.')
		.addText((text) =>
			text
				.setPlaceholder('Your name')
				.setValue(value)
				.onChange(onChange),
		);
}

export class KindleStkSettingTab extends PluginSettingTab {
	plugin: KindleStkPlugin;

	// The cache lets declarative re-renders reuse the last device fetch; the
	// generation counter discards stale completions after refresh/disconnect.
	private destinationCache: { devices: OwnedDevice[]; error: string | null } | null = null;
	private destinationLoadInFlight = false;
	private destinationLoadGeneration = 0;

	constructor(app: App, plugin: KindleStkPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Legacy path for Obsidian <1.13; 1.13+ bypasses display() when
	// getSettingDefinitions() returns a non-empty array.
	display(): void {
		void this.renderLegacy();
	}

	override hide(): void {
		this.invalidateDestinations();
		super.hide();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const isAuthenticated = this.plugin.isAuthenticated();
		const accountState: AccountState = {
			isAuthenticated,
			accountLabel: this.plugin.getAuthenticatedAccountLabel(),
		};
		const selectedSerial = this.plugin.settings.lastDeviceSerial;

		return [
			{
				type: 'group',
				heading: 'Authentication',
				items: [
					{
						name: 'Amazon account',
						desc: accountDescription(accountState),
						aliases: ['Authenticate', 'Re-authenticate', 'connect', 'sign in', 'login', 'OAuth'],
						render: (setting) => {
							buildAccountRow(
								setting,
								accountState,
								() => { void this.handleAuthenticate(); },
							);
						},
					},
					{
						name: 'Disconnect',
						desc: 'Removes the saved credentials from this device only. To fully remove the connection, delete the synthetic "Send to Kindle" device from your Amazon account under Content & Devices → Devices.',
						aliases: ['logout', 'sign out', 'revoke', 'remove credentials'],
						visible: () => this.plugin.isAuthenticated(),
						render: (setting) => {
							buildDisconnectRow(
								setting,
								() => { void this.handleDisconnect(); },
							);
						},
					},
					{
						name: 'Default destination',
						desc: destinationDescription(
							this.getDestinationState(isAuthenticated),
							selectedSerial,
						),
						aliases: ['device', 'Kindle device', 'Send to Kindle library', 'target', 'delivery'],
						render: (setting) => this.renderDestinationRow(setting),
					},
					{
						name: 'Choose destination every time',
						desc: 'When enabled, every send asks where the note should be delivered.',
						aliases: ['prompt', 'ask before sending', 'confirm destination', 'device selection'],
						render: (setting) => {
							buildPromptToggleRow(
								setting,
								this.plugin.settings.promptForDeviceOnSend,
								(value) => { void this.handlePromptToggleChange(value); },
							);
						},
					},
					{
						name: 'Default author',
						desc: 'Used as the author metadata when sending notes.',
						aliases: ['author name', 'creator', 'metadata', 'from name'],
						render: (setting) => {
							buildDefaultAuthorRow(
								setting,
								this.plugin.settings.defaultAuthor,
								(value) => { void this.handleAuthorChange(value); },
							);
						},
					},
				],
			},
		];
	}

	// update() does not exist on Obsidian <1.13; the requireApiVersion() guard
	// ensures we never call a missing runtime API, falling back to redraw.
	private refresh(): void {
		if (requireApiVersion('1.13.0')) {
			this.update();
		} else {
			this.redraw();
		}
	}

	private redraw(): void {
		this.containerEl.empty();
		void this.renderLegacy();
	}

	private async renderLegacy(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		const isAuthenticated = this.plugin.isAuthenticated();
		const accountState: AccountState = {
			isAuthenticated,
			accountLabel: this.plugin.getAuthenticatedAccountLabel(),
		};
		const { devices, error: deviceLoadError } = isAuthenticated
			? await this.plugin.getOwnedDevicesStatus()
			: { devices: [], error: null };

		new Setting(containerEl)
			.setName('Authentication')
			.setHeading();

		buildAccountRow(
			new Setting(containerEl),
			accountState,
			() => { void this.handleAuthenticate(); },
		);

		if (isAuthenticated) {
			buildDisconnectRow(
				new Setting(containerEl),
				() => { void this.handleDisconnect(); },
			);
		}

		const destinationState: DestinationState = !isAuthenticated
			? { kind: 'not-authenticated' }
			: deviceLoadError !== null
				? { kind: 'error', error: deviceLoadError }
				: { kind: 'ready', devices };
		buildDestinationRow(
			new Setting(containerEl),
			destinationState,
			this.plugin.settings.lastDeviceSerial,
			(value) => { void this.handleDestinationChange(value); },
			() => this.refresh(),
		);

		buildPromptToggleRow(
			new Setting(containerEl),
			this.plugin.settings.promptForDeviceOnSend,
			(value) => { void this.handlePromptToggleChange(value); },
		);

		buildDefaultAuthorRow(
			new Setting(containerEl),
			this.plugin.settings.defaultAuthor,
			(value) => { void this.handleAuthorChange(value); },
		);
	}

	// The returned cleanup cancels any in-flight device load on row teardown.
	private renderDestinationRow(setting: Setting): void | (() => void) {
		const isAuthenticated = this.plugin.isAuthenticated();
		const state = this.getDestinationState(isAuthenticated);
		buildDestinationRow(
			setting,
			state,
			this.plugin.settings.lastDeviceSerial,
			(value) => { void this.handleDestinationChange(value); },
			() => this.handleRefreshDestinations(),
		);
		if (state.kind === 'loading') {
			this.loadDestinations();
			return () => {
				this.destinationLoadGeneration += 1;
			};
		}
		return undefined;
	}

	private getDestinationState(isAuthenticated: boolean): DestinationState {
		if (!isAuthenticated) {
			return { kind: 'not-authenticated' };
		}
		const cached = this.destinationCache;
		if (cached === null) {
			return { kind: 'loading' };
		}
		if (cached.error !== null) {
			return { kind: 'error', error: cached.error };
		}
		return { kind: 'ready', devices: cached.devices };
	}

	private loadDestinations(): void {
		if (this.destinationLoadInFlight) {
			return;
		}
		const generation = this.destinationLoadGeneration;
		this.destinationLoadInFlight = true;
		void this.plugin.getOwnedDevicesStatus().then((result) => {
			this.destinationLoadInFlight = false;
			if (generation !== this.destinationLoadGeneration) {
				return;
			}
			this.destinationCache = result;
			this.refresh();
		});
	}

	private invalidateDestinations(): void {
		this.destinationCache = null;
		this.destinationLoadInFlight = false;
		this.destinationLoadGeneration += 1;
	}

	private async handleAuthenticate(): Promise<void> {
		await this.plugin.startOAuthFlow();
		this.invalidateDestinations();
		this.refresh();
	}

	private async handleDisconnect(): Promise<void> {
		await this.plugin.disconnect();
		new Notice('Disconnected from Amazon on this device. If you want to fully revoke access, remove the synthetic "Send to Kindle" device from your Amazon account under Content & Devices → Devices.');
		this.invalidateDestinations();
		this.refresh();
	}

	private handleRefreshDestinations(): void {
		this.invalidateDestinations();
		this.refresh();
	}

	private async handleDestinationChange(value: string): Promise<void> {
		this.plugin.settings.lastDeviceSerial = value || null;
		await this.plugin.saveSettings();
		this.refresh();
	}

	private async handlePromptToggleChange(value: boolean): Promise<void> {
		this.plugin.settings.promptForDeviceOnSend = value;
		await this.plugin.saveSettings();
	}

	private async handleAuthorChange(value: string): Promise<void> {
		this.plugin.settings.defaultAuthor = value;
		await this.plugin.saveSettings();
	}
}
