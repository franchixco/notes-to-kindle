import { App, PluginSettingTab, Setting } from 'obsidian';
import KindleStkPlugin from './main';

export interface KindleStkSettings {
	defaultAuthor: string;
	lastDeviceSerial: string | null;
}

export const DEFAULT_SETTINGS: KindleStkSettings = {
	defaultAuthor: 'Obsidian',
	lastDeviceSerial: null,
};

export class KindleStkSettingTab extends PluginSettingTab {
	plugin: KindleStkPlugin;

	constructor(app: App, plugin: KindleStkPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Authentication')
			.setHeading();

		new Setting(containerEl)
			.setName('Amazon account')
			.setDesc(this.plugin.isAuthenticated()
				? 'Connected — your device is registered with Amazon.'
				: 'Not connected. Authenticate to enable sending to your Kindle.')
			.addButton((btn) => {
				btn.setButtonText(
					this.plugin.isAuthenticated() ? 'Re-authenticate' : 'Authenticate',
				);
				btn.onClick(() => this.plugin.startOAuthFlow());
			});

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
}
