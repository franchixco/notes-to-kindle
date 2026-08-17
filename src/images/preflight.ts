import { Modal, Setting, type App } from 'obsidian';
import type { EpubImageAsset, RemoteImageReference } from './types';

const activeImagePreflights = new Set<Modal>();

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

class ImagePreflightModal extends Modal {
	private confirmed = false;
	private settled = false;
	private readonly resolveChoice: (confirmed: boolean) => void;
	private readonly assets: readonly EpubImageAsset[];
	private readonly remoteImageCount: number;

	constructor(
		app: App,
		assets: readonly EpubImageAsset[],
		remoteImageCount: number,
		resolveChoice: (confirmed: boolean) => void,
	) {
		super(app);
		this.assets = assets;
		this.remoteImageCount = remoteImageCount;
		this.resolveChoice = resolveChoice;
	}

	onOpen(): void {
		activeImagePreflights.add(this);
		const totalBytes = this.assets.reduce((total, asset) => total + asset.data.byteLength, 0);
		const convertedCount = this.assets.filter((asset) => asset.convertedFrom !== undefined).length;
		const remoteAssetCount = this.assets.filter((asset) => asset.remoteSourceUrl !== undefined).length;
		const localImageCount = this.assets.length - remoteAssetCount;
		this.setTitle('Include images?');
		this.contentEl.createEl('p', {
			text: `${this.assets.length} image${this.assets.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}) will be included in the EPUB and sent to Amazon (${localImageCount} local, ${remoteAssetCount} remote).`,
		});
		if (this.remoteImageCount > 0) {
			this.contentEl.createEl('p', {
				text: `${this.remoteImageCount} approved remote image reference${this.remoteImageCount === 1 ? ' was' : 's were'} downloaded for this send. Duplicate bytes are packaged only once.`,
			});
		}
		this.contentEl.createEl('p', {
			text: 'Images included without conversion may retain embedded metadata such as camera details, exif or gps location.',
		});
		if (convertedCount > 0) {
			this.contentEl.createEl('p', {
				text: `${convertedCount} image${convertedCount === 1 ? '' : 's'} will be flattened onto white and converted to JPEG. Source metadata is not intentionally copied.`,
			});
		}
		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText('Cancel');
				button.onClick(() => this.close());
			})
			.addButton((button) => {
				button.setButtonText('Include and send');
				button.setCta();
				button.onClick(() => {
					this.confirmed = true;
					this.close();
				});
			});
	}

	onClose(): void {
		activeImagePreflights.delete(this);
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolveChoice(this.confirmed);
		}
	}
}

class RemoteImageDownloadModal extends Modal {
	private download = false;
	private settled = false;

	constructor(
		app: App,
		private readonly references: readonly RemoteImageReference[],
		private readonly resolveChoice: (download: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		activeImagePreflights.add(this);
		const hosts = new Set<string>();
		for (const reference of this.references) {
			try { hosts.add(new URL(reference.href).hostname); } catch { /* Invalid URLs are omitted later. */ }
		}
		this.setTitle('Download remote images?');
		this.contentEl.createEl('p', {
			text: `${this.references.length} remote image${this.references.length === 1 ? '' : 's'} from ${hosts.size} host${hosts.size === 1 ? '' : 's'} can be downloaded for this send.`,
		});
		if (hosts.size > 0) {
			const list = this.contentEl.createEl('ul');
			for (const host of hosts) list.createEl('li', { text: host });
		}
		this.contentEl.createEl('p', {
			text: 'Downloading contacts those hosts and reveals your IP address. Notes to Kindle sends no cookies or credentials, blocks private network addresses, and does not remember this choice.',
		});
		new Setting(this.contentEl)
			.addButton((button) => {
				button.setButtonText('Skip remote images');
				button.onClick(() => this.close());
			})
			.addButton((button) => {
				button.setButtonText('Download once');
				button.setCta();
				button.onClick(() => { this.download = true; this.close(); });
			});
	}

	onClose(): void {
		activeImagePreflights.delete(this);
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.resolveChoice(this.download);
		}
	}
}

export function confirmRemoteImageDownload(
	app: App,
	references: readonly RemoteImageReference[],
): Promise<boolean> {
	if (references.length === 0) return Promise.resolve(false);
	return new Promise((resolve) => new RemoteImageDownloadModal(app, references, resolve).open());
}

export function confirmImageSend(
	app: App,
	assets: readonly EpubImageAsset[],
	remoteImageCount = 0,
): Promise<boolean> {
	if (assets.length === 0) return Promise.resolve(true);
	return new Promise((resolve) => new ImagePreflightModal(app, assets, remoteImageCount, resolve).open());
}

export function closeActiveImagePreflights(): void {
	for (const modal of [...activeImagePreflights]) modal.close();
}
