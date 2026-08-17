import { MAX_IMAGE_PIXELS } from './types';

export interface StaticWebPInfo {
	width: number;
	height: number;
	hasDeclaredAlpha: boolean;
	kind: 'vp8' | 'vp8l' | 'vp8x';
}

export type WebPInspectionResult =
	| { ok: true; info: StaticWebPInfo }
	| { ok: false; code: 'invalid-image-binary' | 'animated-webp' | 'image-too-large'; reason: string };

const MAX_WEBP_CHUNKS = 10_000;

function fourCc(data: Uint8Array, offset: number): string {
	return String.fromCharCode(...data.subarray(offset, offset + 4));
}

function readU16Le(data: Uint8Array, offset: number): number {
	return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readU24Le(data: Uint8Array, offset: number): number {
	return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
}

function readU32Le(data: Uint8Array, offset: number): number {
	return (((data[offset] ?? 0)
		+ ((data[offset + 1] ?? 0) << 8)
		+ ((data[offset + 2] ?? 0) << 16)
		+ ((data[offset + 3] ?? 0) * 0x1000000)) >>> 0);
}

function invalid(reason: string): WebPInspectionResult {
	return { ok: false, code: 'invalid-image-binary', reason };
}

function safeDimensions(width: number, height: number): WebPInspectionResult | null {
	if (width < 1 || height < 1) return invalid('WebP dimensions must be positive.');
	if (width > MAX_IMAGE_PIXELS / height) {
		return { ok: false, code: 'image-too-large', reason: 'WebP dimensions exceed the safe limit.' };
	}
	return null;
}

export function inspectStaticWebP(data: Uint8Array): WebPInspectionResult {
	if (data.byteLength < 20 || fourCc(data, 0) !== 'RIFF' || fourCc(data, 8) !== 'WEBP') {
		return invalid('Invalid or truncated WebP signature.');
	}
	if (readU32Le(data, 4) !== data.byteLength - 8) return invalid('WebP RIFF size does not match the file.');

	let offset = 12;
	let chunks = 0;
	let primaryCount = 0;
	let width = 0;
	let height = 0;
	let primaryWidth = 0;
	let primaryHeight = 0;
	let hasDeclaredAlpha = false;
	let kind: StaticWebPInfo['kind'] | null = null;
	let sawExtendedHeader = false;

	while (offset < data.byteLength && chunks < MAX_WEBP_CHUNKS) {
		if (offset + 8 > data.byteLength) return invalid('Truncated WebP chunk header.');
		const tag = fourCc(data, offset);
		const size = readU32Le(data, offset + 4);
		const payload = offset + 8;
		const paddedSize = size + (size & 1);
		if (paddedSize > data.byteLength - payload) return invalid('WebP chunk exceeds the file.');
		if ((size & 1) !== 0 && data[payload + size] !== 0) return invalid('WebP chunk padding must be zero.');

		if (tag === 'ANIM' || tag === 'ANMF') {
			return { ok: false, code: 'animated-webp', reason: 'Animated WebP images are not supported.' };
		}
		if (tag === 'VP8X') {
			if (offset !== 12 || sawExtendedHeader || size !== 10) return invalid('Invalid WebP extended header.');
			const flags = data[payload] ?? 0;
			if ((flags & 0x02) !== 0) {
				return { ok: false, code: 'animated-webp', reason: 'Animated WebP images are not supported.' };
			}
			if ((flags & 0xc1) !== 0) return invalid('WebP extended header uses reserved flags.');
			hasDeclaredAlpha = (flags & 0x10) !== 0;
			width = readU24Le(data, payload + 4) + 1;
			height = readU24Le(data, payload + 7) + 1;
			kind = 'vp8x';
			sawExtendedHeader = true;
		} else if (tag === 'VP8 ') {
			if (size < 10 || data[payload + 3] !== 0x9d || data[payload + 4] !== 0x01 || data[payload + 5] !== 0x2a) {
				return invalid('Invalid WebP VP8 frame header.');
			}
			primaryWidth = readU16Le(data, payload + 6) & 0x3fff;
			primaryHeight = readU16Le(data, payload + 8) & 0x3fff;
			primaryCount += 1;
			kind ??= 'vp8';
		} else if (tag === 'VP8L') {
			if (size < 5 || data[payload] !== 0x2f) return invalid('Invalid WebP VP8L frame header.');
			primaryWidth = 1 + (data[payload + 1] ?? 0) + (((data[payload + 2] ?? 0) & 0x3f) << 8);
			primaryHeight = 1 + ((data[payload + 2] ?? 0) >> 6)
				+ ((data[payload + 3] ?? 0) << 2)
				+ (((data[payload + 4] ?? 0) & 0x0f) << 10);
			hasDeclaredAlpha = true;
			primaryCount += 1;
			kind ??= 'vp8l';
		}

		offset = payload + paddedSize;
		chunks += 1;
	}
	if (chunks >= MAX_WEBP_CHUNKS || offset !== data.byteLength) return invalid('Invalid WebP chunk layout.');
	if (primaryCount !== 1 || kind === null) return invalid('WebP must contain exactly one primary image bitstream.');
	if (!sawExtendedHeader) {
		width = primaryWidth;
		height = primaryHeight;
	} else if (primaryWidth > 0 && (primaryWidth !== width || primaryHeight !== height)) {
		return invalid('WebP frame dimensions disagree with the extended header.');
	}
	const dimensionError = safeDimensions(width, height);
	if (dimensionError) return dimensionError;
	return { ok: true, info: { width, height, hasDeclaredAlpha, kind } };
}
