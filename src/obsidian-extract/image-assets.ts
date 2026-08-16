import type crypto from 'crypto';
import type { App, TFile } from 'obsidian';
import {
	MAX_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	MAX_UNIQUE_IMAGES,
	type EpubImageAsset,
	type ImageWarning,
} from '../images/types';
import { validateImage } from '../images/validate';

type RegisterResult = { ok: true; asset: EpubImageAsset } | { ok: false; warning: ImageWarning };
type CachedResult = { ok: true; asset: EpubImageAsset } | {
	ok: false;
	code: ImageWarning['code'];
	message: string;
};

export interface ImageRegistryLimits {
	maxImageBytes: number;
	maxTotalBytes: number;
	maxUniqueImages: number;
}

const DEFAULT_LIMITS: ImageRegistryLimits = {
	maxImageBytes: MAX_IMAGE_BYTES,
	maxTotalBytes: MAX_TOTAL_IMAGE_BYTES,
	maxUniqueImages: MAX_UNIQUE_IMAGES,
};

function warning(
	code: ImageWarning['code'],
	sourcePath: string,
	target: string,
	message: string,
): RegisterResult {
	return { ok: false, warning: { code, sourcePath, target, message } };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

export class ImageAssetRegistry {
	private readonly byHash = new Map<string, EpubImageAsset>();
	private readonly byPath = new Map<string, CachedResult>();
	private readonly collectedWarnings: ImageWarning[] = [];
	private totalBytes = 0;
	private readonly limits: ImageRegistryLimits;

	constructor(limits: ImageRegistryLimits = DEFAULT_LIMITS) {
		this.limits = limits;
	}

	async register(app: App, file: TFile, sourcePath: string, target: string): Promise<RegisterResult> {
		const cached = this.byPath.get(file.path);
		if (cached) {
			return cached.ok ? cached : warning(cached.code, sourcePath, target, cached.message);
		}
		const extension = file.extension.toLowerCase();
		if (!['jpg', 'jpeg', 'png', 'gif'].includes(extension)) {
			const result: CachedResult = {
				ok: false,
				code: 'unsupported-image-format',
				message: 'Only JPEG, opaque PNG and static GIF are supported.',
			};
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}
		if (file.stat.size > this.limits.maxImageBytes) {
			const result: CachedResult = { ok: false, code: 'image-too-large', message: 'Image exceeds the 10 MiB limit.' };
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}
		if (this.byHash.size >= this.limits.maxUniqueImages
			|| file.stat.size > this.limits.maxTotalBytes - this.totalBytes) {
			return warning('image-budget-exceeded', sourcePath, target, 'The note exceeds the image budget.');
		}
		let data: Uint8Array;
		try {
			data = new Uint8Array(await app.vault.readBinary(file));
		} catch {
			const result: CachedResult = { ok: false, code: 'image-read-failed', message: 'A local image could not be read.' };
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}
		const validation = validateImage(data, file.extension);
		if (!validation.ok) {
			const result: CachedResult = { ok: false, code: validation.code, message: validation.reason };
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}

		const nodeCrypto = window.require('crypto') as typeof crypto;
		const hash = nodeCrypto.createHash('sha256').update(data).digest('hex');
		const existing = this.byHash.get(hash);
		if (existing) {
			if (!sameBytes(existing.data, data)) {
				return warning('invalid-image-binary', sourcePath, target, 'An image hash collision was detected.');
			}
			const result: CachedResult = { ok: true, asset: existing };
			this.byPath.set(file.path, result);
			return result;
		}
		if (this.byHash.size >= this.limits.maxUniqueImages
			|| data.byteLength > this.limits.maxTotalBytes - this.totalBytes) {
			const result: CachedResult = { ok: false, code: 'image-budget-exceeded', message: 'The note exceeds the image budget.' };
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}
		const image = validation.image;
		const asset: EpubImageAsset = {
			hash,
			href: `images/${hash}.${image.extension}`,
			mediaType: image.mediaType,
			data,
			sourcePath: file.path,
			width: image.width,
			height: image.height,
		};
		this.byHash.set(hash, asset);
		this.byPath.set(file.path, { ok: true, asset });
		this.totalBytes += data.byteLength;
		return { ok: true, asset };
	}

	addWarning(value: ImageWarning): void {
		this.collectedWarnings.push(value);
	}

	assets(): EpubImageAsset[] {
		return [...this.byHash.values()];
	}

	warnings(): ImageWarning[] {
		return [...this.collectedWarnings];
	}
}
