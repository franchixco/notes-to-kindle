import { Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, KindleStkSettings, KindleStkSettingTab } from './settings';
import { extractNote } from './obsidian-extract/extract';
import { buildEpub } from './epub/builder';
import { generatePkce, runOAuthFlowWithPkce } from './stk/oauth';
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
		return this.app.secretStorage.getSecret(SECRET_KEY) !== null;
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

	async startOAuthFlow(): Promise<void> {
		try {
			const pkce = await generatePkce();
			const result = await runOAuthFlowWithPkce(pkce, buildAmazonAuthUrl);
			const creds = await registerDevice(result.authorizationCode, pkce.verifier);
			this.storeCredentials(creds);

			const devices = await listOwnedDevices(creds);
			if (devices.length > 0) {
				this.settings.lastDeviceSerial = devices[0]!.serialNumber;
				await this.saveSettings();
			}

			new Notice('Authenticated successfully. Found ' + devices.length + ' Kindle device(s).');
		} catch (err) {
			new Notice('Authentication failed: ' + (err as Error).message);
			console.error('STK auth failed', err);
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

		if (devices.length === 0) {
			new Notice('No kindle devices found on your account.');
			return;
		}

		const targetSerials = this.settings.lastDeviceSerial
			? [this.settings.lastDeviceSerial]
			: devices.map((d) => d.serialNumber);

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
			} catch {
				// temp file may not exist if we failed before writing
			}
		}
	}
}
