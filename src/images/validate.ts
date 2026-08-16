import {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_PIXELS,
	type ImageValidationResult,
	type SupportedImageExtension,
} from './types';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const MAX_STRUCTURES = 10_000;

function invalid(reason: string): ImageValidationResult {
	return { ok: false, code: 'invalid-image-binary', reason };
}

function dimensionsValid(width: number, height: number): boolean {
	return width > 0 && height > 0 && width <= MAX_IMAGE_PIXELS / height;
}

function crc32(data: Uint8Array, start: number, end: number): number {
	let crc = 0xffffffff;
	for (let index = start; index < end; index += 1) {
		crc ^= data[index] ?? 0;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function readU16Be(data: Uint8Array, offset: number): number {
	return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

function readU16Le(data: Uint8Array, offset: number): number {
	return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readU32Be(data: Uint8Array, offset: number): number {
	return (((data[offset] ?? 0) * 0x1000000)
		+ ((data[offset + 1] ?? 0) << 16)
		+ ((data[offset + 2] ?? 0) << 8)
		+ (data[offset + 3] ?? 0)) >>> 0;
}

function parsePng(data: Uint8Array): ImageValidationResult {
	if (data.length < 45 || !PNG_SIGNATURE.every((byte, index) => data[index] === byte)) {
		return invalid('Invalid PNG signature or truncated file.');
	}
	let offset = 8;
	let width = 0;
	let height = 0;
	let colorType = -1;
	let bitDepth = -1;
	let sawHeader = false;
	let sawData = false;
	let dataBytes = 0;
	let sawEnd = false;
	let sawPalette = false;
	let chunkCount = 0;
	let hasTransparency = false;

	while (offset < data.length && chunkCount < MAX_STRUCTURES) {
		if (offset + 12 > data.length) return invalid('Truncated PNG chunk.');
		const length = readU32Be(data, offset);
		if (length > data.length - offset - 12) return invalid('PNG chunk length exceeds the file.');
		const typeStart = offset + 4;
		const payloadStart = offset + 8;
		const payloadEnd = payloadStart + length;
		const type = String.fromCharCode(...data.subarray(typeStart, typeStart + 4));
		const expectedCrc = readU32Be(data, payloadEnd);
		if (crc32(data, typeStart, payloadEnd) !== expectedCrc) return invalid(`Invalid PNG ${type} CRC.`);

		if (!sawHeader) {
			if (type !== 'IHDR' || length !== 13) return invalid('PNG IHDR must be first and 13 bytes long.');
			width = readU32Be(data, payloadStart);
			height = readU32Be(data, payloadStart + 4);
			bitDepth = data[payloadStart + 8] ?? -1;
			colorType = data[payloadStart + 9] ?? -1;
			const validDepths: Record<number, readonly number[]> = {
				0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
			};
			if (!validDepths[colorType]?.includes(bitDepth)) return invalid('Invalid PNG bit depth or color type.');
			if ((data[payloadStart + 10] ?? -1) !== 0 || (data[payloadStart + 11] ?? -1) !== 0) {
				return invalid('Unsupported PNG compression or filter method.');
			}
			if (![0, 1].includes(data[payloadStart + 12] ?? -1)) return invalid('Invalid PNG interlace method.');
			if (!dimensionsValid(width, height)) {
				return { ok: false, code: 'image-too-large', reason: 'PNG dimensions exceed the safe limit.' };
			}
			hasTransparency = colorType === 4 || colorType === 6;
			sawHeader = true;
		} else if (type === 'IHDR') {
			return invalid('PNG contains more than one IHDR chunk.');
		} else if (type === 'tRNS') {
			if (sawData || hasTransparency) return invalid('Invalid PNG tRNS placement.');
			if ((colorType === 0 && length !== 2) || (colorType === 2 && length !== 6) || (colorType === 3 && length < 1)) {
				return invalid('Invalid PNG tRNS length.');
			}
			hasTransparency = true;
		} else if (type === 'PLTE') {
			const entries = length / 3;
			if (sawData || sawPalette || colorType === 0 || colorType === 4
				|| length === 0 || length % 3 !== 0 || length > 768
				|| (colorType === 3 && entries > 2 ** bitDepth)) return invalid('Invalid PNG palette.');
			sawPalette = true;
		} else if (type === 'IDAT') {
			if (colorType === 3 && !sawPalette) return invalid('Indexed PNG is missing its palette.');
			sawData = true;
			dataBytes += length;
		} else if (type === 'IEND') {
			if (length !== 0 || !sawData || dataBytes === 0 || payloadEnd + 4 !== data.length) {
				return invalid('Invalid PNG IEND chunk or empty image data.');
			}
			sawEnd = true;
			offset = data.length;
			break;
		} else if (/^[A-Z]/.test(type)) return invalid(`Unknown critical PNG chunk ${type}.`);

		offset = payloadEnd + 4;
		chunkCount += 1;
	}
	if (chunkCount >= MAX_STRUCTURES || !sawEnd) return invalid('PNG is missing a valid IEND chunk.');
	if (hasTransparency) {
		return { ok: false, code: 'transparent-image', reason: 'Transparent PNG images are not supported by this MVP.' };
	}
	return { ok: true, image: { mediaType: 'image/png', extension: 'png', width, height } };
}

function skipGifSubBlocks(data: Uint8Array, initialOffset: number): { offset: number; dataBytes: number } | null {
	let offset = initialOffset;
	let blocks = 0;
	let dataBytes = 0;
	while (blocks < MAX_STRUCTURES) {
		if (offset >= data.length) return null;
		const length = data[offset] ?? 0;
		offset += 1;
		if (length === 0) return { offset, dataBytes };
		if (length > data.length - offset) return null;
		offset += length;
		dataBytes += length;
		blocks += 1;
	}
	return null;
}

function parseGif(data: Uint8Array): ImageValidationResult {
	if (data.length < 14) return invalid('Truncated GIF file.');
	const signature = String.fromCharCode(...data.subarray(0, 6));
	if (signature !== 'GIF87a' && signature !== 'GIF89a') return invalid('Invalid GIF signature.');
	const width = readU16Le(data, 6);
	const height = readU16Le(data, 8);
	if (!dimensionsValid(width, height)) {
		return { ok: false, code: 'image-too-large', reason: 'GIF dimensions exceed the safe limit.' };
	}
	const packed = data[10] ?? 0;
	let offset = 13;
	if ((packed & 0x80) !== 0) {
		const tableBytes = 3 * (1 << ((packed & 0x07) + 1));
		if (tableBytes > data.length - offset) return invalid('Truncated GIF global color table.');
		offset += tableBytes;
	}
	let frames = 0;
	let transparent = false;
	let structures = 0;
	while (offset < data.length && structures < MAX_STRUCTURES) {
		const marker = data[offset] ?? -1;
		offset += 1;
		if (marker === 0x3b) {
			if (offset !== data.length || frames === 0) return invalid('Invalid GIF trailer.');
			if (frames > 1) return { ok: false, code: 'animated-gif', reason: 'Animated GIF images are not supported.' };
			if (transparent) return { ok: false, code: 'transparent-image', reason: 'Transparent GIF images are not supported.' };
			return { ok: true, image: { mediaType: 'image/gif', extension: 'gif', width, height } };
		}
		if (marker === 0x2c) {
			if (offset + 9 > data.length) return invalid('Truncated GIF image descriptor.');
			const left = readU16Le(data, offset);
			const top = readU16Le(data, offset + 2);
			const frameWidth = readU16Le(data, offset + 4);
			const frameHeight = readU16Le(data, offset + 6);
			const imagePacked = data[offset + 8] ?? 0;
			if (frameWidth === 0 || frameHeight === 0 || left + frameWidth > width || top + frameHeight > height) {
				return invalid('Invalid GIF frame dimensions.');
			}
			offset += 9;
			if ((imagePacked & 0x80) !== 0) {
				const tableBytes = 3 * (1 << ((imagePacked & 0x07) + 1));
				if (tableBytes > data.length - offset) return invalid('Truncated GIF local color table.');
				offset += tableBytes;
			}
			if (offset >= data.length) return invalid('GIF is missing LZW data.');
			const minimumCodeSize = data[offset] ?? 0;
			if (minimumCodeSize < 2 || minimumCodeSize > 8) return invalid('Invalid GIF LZW minimum code size.');
			offset += 1;
			const imageData = skipGifSubBlocks(data, offset);
			if (!imageData || imageData.dataBytes === 0) return invalid('Truncated or empty GIF image data.');
			offset = imageData.offset;
			frames += 1;
		} else if (marker === 0x21) {
			if (offset >= data.length) return invalid('Truncated GIF extension.');
			const label = data[offset] ?? -1;
			offset += 1;
			if (label === 0xf9) {
				if (offset + 6 > data.length || data[offset] !== 4 || data[offset + 5] !== 0) {
					return invalid('Invalid GIF graphic control extension.');
				}
				transparent ||= ((data[offset + 1] ?? 0) & 0x01) !== 0;
				offset += 6;
			} else if (label === 0xfe) {
				const blocks = skipGifSubBlocks(data, offset);
				if (!blocks) return invalid('Truncated GIF extension data.');
				offset = blocks.offset;
			} else if (label === 0xff || label === 0x01) {
				const expected = label === 0xff ? 11 : 12;
				if (offset >= data.length || data[offset] !== expected || expected > data.length - offset - 1) {
					return invalid('Invalid GIF extension header.');
				}
				offset += expected + 1;
				const blocks = skipGifSubBlocks(data, offset);
				if (!blocks) return invalid('Truncated GIF extension data.');
				offset = blocks.offset;
			} else {
				return invalid('Unknown GIF extension.');
			}
		} else {
			return invalid('Unknown GIF block marker.');
		}
		structures += 1;
	}
	return invalid('GIF is missing a valid trailer.');
}

function markerHasNoLength(marker: number): boolean {
	return marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function parseJpeg(data: Uint8Array): ImageValidationResult {
	if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return invalid('Invalid JPEG SOI marker.');
	let offset = 2;
	let width = 0;
	let height = 0;
	let inScan = false;
	let sawScan = false;
	let scanDataBytes = 0;
	let sawFrame = false;
	const frameComponents = new Set<number>();
	let structures = 0;
	while (offset < data.length && structures < MAX_STRUCTURES) {
		if (inScan) {
			const scanStart = offset;
			while (offset < data.length && data[offset] !== 0xff) offset += 1;
			scanDataBytes += offset - scanStart;
			if (offset >= data.length) return invalid('JPEG is missing EOI.');
		}
		if (data[offset] !== 0xff) return invalid('Invalid JPEG marker boundary.');
		while (offset < data.length && data[offset] === 0xff) offset += 1;
		if (offset >= data.length) return invalid('Truncated JPEG marker.');
		const marker = data[offset] ?? -1;
		offset += 1;
		if (inScan && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) continue;
		inScan = false;
		if (marker === 0xd9) {
			if (offset !== data.length || width === 0 || height === 0 || !sawScan || scanDataBytes === 0) {
				return invalid('Invalid JPEG EOI, missing scan, or empty scan data.');
			}
			return { ok: true, image: { mediaType: 'image/jpeg', extension: 'jpg', width, height } };
		}
		if (markerHasNoLength(marker)) {
			structures += 1;
			continue;
		}
		if (offset + 2 > data.length) return invalid('Truncated JPEG segment length.');
		const length = readU16Be(data, offset);
		if (length < 2 || length > data.length - offset) return invalid('Invalid JPEG segment length.');
		const body = offset + 2;
		if (JPEG_SOF_MARKERS.has(marker)) {
			if (sawFrame) return invalid('JPEG contains more than one frame header.');
			if (length < 8) return invalid('Truncated JPEG SOF segment.');
			const nextHeight = readU16Be(data, body + 1);
			const nextWidth = readU16Be(data, body + 3);
			const components = data[body + 5] ?? 0;
			if (components < 1 || components > 4 || length !== 8 + 3 * components
				|| !dimensionsValid(nextWidth, nextHeight)) {
				return { ok: false, code: 'image-too-large', reason: 'Invalid or oversized JPEG dimensions.' };
			}
			width = nextWidth;
			height = nextHeight;
			for (let component = 0; component < components; component += 1) {
				const id = data[body + 6 + component * 3] ?? -1;
				if (frameComponents.has(id)) return invalid('JPEG frame contains duplicate component identifiers.');
				frameComponents.add(id);
			}
			sawFrame = true;
		}
		if (marker === 0xda) {
			if (!sawFrame) return invalid('JPEG scan appears before its frame header.');
			const scanComponents = data[body] ?? 0;
			if (scanComponents < 1 || scanComponents > 4 || length !== 6 + 2 * scanComponents) {
				return invalid('Invalid JPEG SOS segment.');
			}
			const selected = new Set<number>();
			for (let component = 0; component < scanComponents; component += 1) {
				const id = data[body + 1 + component * 2] ?? -1;
				if (!frameComponents.has(id) || selected.has(id)) return invalid('JPEG scan references an invalid component.');
				selected.add(id);
			}
			sawScan = true;
		}
		offset += length;
		if (marker === 0xda) inScan = true;
		structures += 1;
	}
	return invalid('JPEG is missing a valid EOI marker.');
}

export function validateImage(data: Uint8Array, declaredExtension: string): ImageValidationResult {
	if (data.byteLength > MAX_IMAGE_BYTES) {
		return { ok: false, code: 'image-too-large', reason: 'Image exceeds the 10 MiB limit.' };
	}
	const normalized = declaredExtension.toLowerCase().replace(/^\./, '');
	const candidate = normalized === 'jpeg' ? 'jpg' : normalized;
	if (!['jpg', 'png', 'gif'].includes(candidate)) {
		return { ok: false, code: 'unsupported-image-format', reason: 'Only JPEG, opaque PNG and static GIF are supported.' };
	}
	const sniffed: SupportedImageExtension | null = data[0] === 0xff && data[1] === 0xd8
		? 'jpg'
		: PNG_SIGNATURE.every((byte, index) => data[index] === byte)
			? 'png'
			: String.fromCharCode(...data.subarray(0, 6)).match(/^GIF8[79]a$/) ? 'gif' : null;
	if (sniffed === null || sniffed !== candidate) return invalid('Image extension does not match its binary signature.');
	if (sniffed === 'png') return parsePng(data);
	if (sniffed === 'gif') return parseGif(data);
	return parseJpeg(data);
}
