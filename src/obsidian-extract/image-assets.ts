import type crypto from 'crypto';
import type { App, TFile } from 'obsidian';
import {
	chromiumRasterToJpeg,
	ImageConversionUnavailableError,
	type ConvertibleMediaType,
	type RasterToJpeg,
} from '../images/convert';
import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_CONVERSIONS,
	MAX_TOTAL_IMAGE_BYTES,
	MAX_UNIQUE_IMAGES,
	type EpubImageAsset,
	type ImageWarning,
} from '../images/types';
import { validateImage } from '../images/validate';
import { inspectStaticWebP } from '../images/webp';

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
	maxConversions: number;
}

const DEFAULT_LIMITS: ImageRegistryLimits = {
	maxImageBytes: MAX_IMAGE_BYTES,
	maxTotalBytes: MAX_TOTAL_IMAGE_BYTES,
	maxUniqueImages: MAX_UNIQUE_IMAGES,
	maxConversions: MAX_IMAGE_CONVERSIONS,
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
	private readonly byConvertibleSource = new Map<string, CachedResult>();
	private readonly collectedWarnings: ImageWarning[] = [];
	private totalBytes = 0;
	private readonly limits: ImageRegistryLimits;
	private readonly rasterToJpeg: RasterToJpeg;
	private conversionAttempts = 0;

	constructor(limits: ImageRegistryLimits = DEFAULT_LIMITS, rasterToJpeg: RasterToJpeg = chromiumRasterToJpeg) {
		this.limits = limits;
		this.rasterToJpeg = rasterToJpeg;
	}

	async register(app: App, file: TFile, sourcePath: string, target: string): Promise<RegisterResult> {
		const cached = this.byPath.get(file.path);
		if (cached) {
			return cached.ok ? cached : warning(cached.code, sourcePath, target, cached.message);
		}
		const extension = file.extension.toLowerCase();
		if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension)) {
			const result: CachedResult = {
				ok: false,
				code: 'unsupported-image-format',
				message: 'Only supported local raster image formats can be included.',
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
			|| this.totalBytes >= this.limits.maxTotalBytes
			|| (!['png', 'webp'].includes(extension)
				&& file.stat.size > this.limits.maxTotalBytes - this.totalBytes)) {
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
		if (data.byteLength > this.limits.maxImageBytes) {
			const result: CachedResult = { ok: false, code: 'image-too-large', message: 'Image exceeds the 10 MiB limit.' };
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}

		let finalData = data;
		let convertedFrom: ConvertibleMediaType | undefined;
		let conversionSourceKey: string | undefined;
		const nodeCrypto = window.require('crypto') as typeof crypto;
		let validation = extension === 'webp'
			? null
			: validateImage(finalData, file.extension);

		if (extension === 'webp') {
			const inspection = inspectStaticWebP(data);
			if (!inspection.ok) {
				const result: CachedResult = { ok: false, code: inspection.code, message: inspection.reason };
				this.byPath.set(file.path, result);
				return warning(result.code, sourcePath, target, result.message);
			}
			convertedFrom = 'image/webp';
		} else if (extension === 'png' && validation && !validation.ok && validation.code === 'transparent-image') {
			convertedFrom = 'image/png';
		}

		if (convertedFrom) {
			const sourceHash = nodeCrypto.createHash('sha256').update(data).digest('hex');
			const sourceKey = `${convertedFrom}:${sourceHash}`;
			conversionSourceKey = sourceKey;
			const sourceCached = this.byConvertibleSource.get(sourceKey);
			if (sourceCached) {
				this.byPath.set(file.path, sourceCached);
				return sourceCached.ok
					? sourceCached
					: warning(sourceCached.code, sourcePath, target, sourceCached.message);
			}
			if (this.conversionAttempts >= this.limits.maxConversions) {
				const result: CachedResult = { ok: false, code: 'image-budget-exceeded', message: 'The note exceeds the image conversion limit.' };
				this.byConvertibleSource.set(sourceKey, result);
				this.byPath.set(file.path, result);
				return warning(result.code, sourcePath, target, result.message);
			}
			this.conversionAttempts += 1;
			try {
				finalData = await this.rasterToJpeg.convert(data, convertedFrom);
			} catch (error) {
				const unavailable = error instanceof ImageConversionUnavailableError;
				const result: CachedResult = {
					ok: false,
					code: unavailable ? 'image-conversion-unavailable' : 'image-conversion-failed',
					message: unavailable ? 'Local image conversion is unavailable.' : 'Local image conversion failed.',
				};
				this.byConvertibleSource.set(sourceKey, result);
				this.byPath.set(file.path, result);
				return warning(result.code, sourcePath, target, result.message);
			}
			if (finalData.byteLength > this.limits.maxImageBytes) {
				const result: CachedResult = { ok: false, code: 'image-too-large', message: 'Converted image exceeds the 10 MiB limit.' };
				this.byConvertibleSource.set(sourceKey, result);
				this.byPath.set(file.path, result);
				return warning(result.code, sourcePath, target, result.message);
			}
			validation = validateImage(finalData, 'jpg');
			if (!validation.ok) {
				const result: CachedResult = { ok: false, code: validation.code, message: validation.reason };
				this.byConvertibleSource.set(sourceKey, result);
				this.byPath.set(file.path, result);
				return warning(result.code, sourcePath, target, result.message);
			}
		}

		if (validation === null) {
			const result: CachedResult = { ok: false, code: 'invalid-image-binary', message: 'Image conversion did not produce a valid JPEG.' };
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}
		if (!validation.ok) {
			const result: CachedResult = { ok: false, code: validation.code, message: validation.reason };
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}

		const hash = nodeCrypto.createHash('sha256').update(finalData).digest('hex');
		const existing = this.byHash.get(hash);
		if (existing) {
			if (!sameBytes(existing.data, finalData)) {
				return warning('invalid-image-binary', sourcePath, target, 'An image hash collision was detected.');
			}
			const result: CachedResult = { ok: true, asset: existing };
			if (conversionSourceKey) this.byConvertibleSource.set(conversionSourceKey, result);
			this.byPath.set(file.path, result);
			return result;
		}
		if (this.byHash.size >= this.limits.maxUniqueImages
			|| finalData.byteLength > this.limits.maxTotalBytes - this.totalBytes) {
			const result: CachedResult = { ok: false, code: 'image-budget-exceeded', message: 'The note exceeds the image budget.' };
			if (conversionSourceKey) this.byConvertibleSource.set(conversionSourceKey, result);
			this.byPath.set(file.path, result);
			return warning(result.code, sourcePath, target, result.message);
		}
		const image = validation.image;
		const asset: EpubImageAsset = {
			hash,
			href: `images/${hash}.${image.extension}`,
			mediaType: image.mediaType,
			data: finalData,
			sourcePath: file.path,
			width: image.width,
			height: image.height,
			convertedFrom,
		};
		this.byHash.set(hash, asset);
		const result: CachedResult = { ok: true, asset };
		this.byPath.set(file.path, result);
		if (conversionSourceKey) this.byConvertibleSource.set(conversionSourceKey, result);
		this.totalBytes += finalData.byteLength;
		return result;
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
