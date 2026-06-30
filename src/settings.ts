import { App, PluginSettingTab, Setting } from 'obsidian';
import KindleStkPlugin from './main';

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

export class KindleStkSettingTab extends PluginSettingTab {
	plugin: KindleStkPlugin;

	constructor(app: App, plugin: KindleStkPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		void this.render();
	}

	private async render(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		const isAuthenticated = this.plugin.isAuthenticated();
		const accountLabel = this.plugin.getAuthenticatedAccountLabel();
		const { devices, error: deviceLoadError } = isAuthenticated
			? await this.plugin.getOwnedDevicesStatus()
			: { devices: [], error: null };
		const selectedDevice = devices.find(
			(device) => device.serialNumber === this.plugin.settings.lastDeviceSerial,
		);

		new Setting(containerEl)
			.setName('Authentication')
			.setHeading();

		new Setting(containerEl)
			.setName('Amazon account')
			.setDesc(isAuthenticated
				? `Connected${accountLabel ? ` as ${accountLabel}` : ''}.`
				: 'Not connected. Authenticate to enable sending to your Kindle.')
			.addButton((btn) => {
				btn.setButtonText(
					isAuthenticated ? 'Re-authenticate' : 'Authenticate',
				);
				btn.onClick(() => void this.plugin.startOAuthFlow().then(() => this.redraw()));
			});

		new Setting(containerEl)
			.setName('Default destination')
			.setDesc(deviceLoadError
				? `Could not load destinations: ${deviceLoadError}`
				: selectedDevice
				? `${selectedDevice.deviceName} (${selectedDevice.serialNumber})`
				: isAuthenticated
					? 'Send to Kindle library only.'
					: 'Authenticate first to load your destinations.')
			.addDropdown((dropdown) => {
				dropdown.addOption('', 'Send to kindle library');
				for (const device of devices) {
					dropdown.addOption(device.serialNumber, `${device.deviceName} (${device.serialNumber})`);
				}
				dropdown.setValue(this.plugin.settings.lastDeviceSerial ?? '');
				dropdown.setDisabled(!isAuthenticated || deviceLoadError !== null);
				dropdown.onChange(async (value) => {
					this.plugin.settings.lastDeviceSerial = value || null;
					await this.plugin.saveSettings();
					this.redraw();
				});
			})
			.addExtraButton((btn) => {
				btn.setIcon('refresh-cw');
				btn.setTooltip('Refresh device list');
				btn.setDisabled(!isAuthenticated);
				btn.onClick(() => this.redraw());
			});

		new Setting(containerEl)
			.setName('Choose destination every time')
			.setDesc('When enabled, every send asks where the note should be delivered.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.promptForDeviceOnSend)
					.onChange(async (value) => {
						this.plugin.settings.promptForDeviceOnSend = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Default author')
			.setDesc('Used as the author metadata when sending notes.')
			.addText((text) =>
				text
					.setPlaceholder('Your name')
					.setValue(this.plugin.settings.defaultAuthor)
					.onChange(async (value) => {
						this.plugin.settings.defaultAuthor = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private redraw(): void {
		this.containerEl.empty();
		void this.render();
	}
}
