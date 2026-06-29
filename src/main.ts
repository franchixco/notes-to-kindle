import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, KindleStkSettings, KindleStkSettingTab } from './settings';

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
		return false;
	}

	async startOAuthFlow(): Promise<void> {
		new Notice('Not implemented yet');
	}

	private async sendToKindle(_file: import('obsidian').TFile): Promise<void> {
		new Notice('Not implemented yet');
	}
}
