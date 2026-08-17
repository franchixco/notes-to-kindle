import { Modal, Setting, type App } from 'obsidian';
import type { EpubImageAsset } from './types';

const activeImagePreflights = new Set<ImagePreflightModal>();

function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

class ImagePreflightModal extends Modal {
	private confirmed = false;
	private settled = false;
	private readonly resolveChoice: (confirmed: boolean) => void;
	private readonly assets: readonly EpubImageAsset[];

	constructor(app: App, assets: readonly EpubImageAsset[], resolveChoice: (confirmed: boolean) => void) {
		super(app);
		this.assets = assets;
		this.resolveChoice = resolveChoice;
	}

	onOpen(): void {
		activeImagePreflights.add(this);
		const totalBytes = this.assets.reduce((total, asset) => total + asset.data.byteLength, 0);
		this.setTitle('Include local images?');
		this.contentEl.createEl('p', {
			text: `${this.assets.length} local image${this.assets.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}) will be included in the EPUB and sent to Amazon.`,
		});
		this.contentEl.createEl('p', {
			text: 'Original image bytes may contain embedded metadata such as camera details, exif or gps location.',
		});
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

export function confirmImageSend(app: App, assets: readonly EpubImageAsset[]): Promise<boolean> {
	if (assets.length === 0) return Promise.resolve(true);
	return new Promise((resolve) => new ImagePreflightModal(app, assets, resolve).open());
}

export function closeActiveImagePreflights(): void {
	for (const modal of [...activeImagePreflights]) modal.close();
}
