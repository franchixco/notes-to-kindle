import { describe, expect, it } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { validateImage } from '../src/images/validate';
import { MAX_IMAGE_BYTES } from '../src/images/types';

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function u32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function pngChunk(type: string, payload: number[]): number[] {
	const typeBytes = [...new TextEncoder().encode(type)];
	const crc = crc32(new Uint8Array([...typeBytes, ...payload]));
	return [...u32(payload.length), ...typeBytes, ...payload, ...u32(crc)];
}

function png(
	width = 2,
	height = 3,
	colorType = 2,
	extraChunks: number[][] = [],
	bitDepth = 8,
): Uint8Array {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const header = pngChunk('IHDR', [...u32(width), ...u32(height), bitDepth, colorType, 0, 0, 0]);
	const channels = colorType === 6 ? 4 : 3;
	const scanlines = new Uint8Array(height * (1 + width * channels));
	for (let row = 0; row < height; row += 1) scanlines[row * (1 + width * channels)] = 0;
	return new Uint8Array([
		...signature,
		...header,
		...extraChunks.flat(),
		...pngChunk('IDAT', [...deflateSync(scanlines)]),
		...pngChunk('IEND', []),
	]);
}

function jpeg(): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8,
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00,
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
		0x12, 0x34, 0xff, 0x00, 0x56,
		0xff, 0xd9,
	]);
}

function gif(frameCount = 1, transparent = false): Uint8Array {
	const bytes = [
		...new TextEncoder().encode('GIF89a'),
		0x02, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00,
	];
	if (transparent) bytes.push(0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00);
	for (let frame = 0; frame < frameCount; frame += 1) {
		bytes.push(
			0x2c,
			0x00, 0x00, 0x00, 0x00,
			0x02, 0x00, 0x03, 0x00,
			0x00,
			0x02, 0x01, 0x00, 0x00,
		);
	}
	bytes.push(0x3b);
	return new Uint8Array(bytes);
}

describe('validateImage', () => {
	it('accepts structurally valid JPEG, opaque PNG and static GIF images', () => {
		expect(validateImage(jpeg(), 'jpeg')).toEqual({
			ok: true,
			image: { mediaType: 'image/jpeg', extension: 'jpg', width: 2, height: 3 },
		});
		expect(validateImage(png(), 'png')).toEqual({
			ok: true,
			image: { mediaType: 'image/png', extension: 'png', width: 2, height: 3 },
		});
		expect(validateImage(gif(), 'gif')).toEqual({
			ok: true,
			image: { mediaType: 'image/gif', extension: 'gif', width: 2, height: 3 },
		});
	});

	it('rejects signature mismatches and truncated binaries', () => {
		expect(validateImage(jpeg(), 'png')).toMatchObject({ ok: false, code: 'invalid-image-binary' });
		expect(validateImage(jpeg().slice(0, -2), 'jpg')).toMatchObject({ ok: false, code: 'invalid-image-binary' });
		expect(validateImage(png().slice(0, -1), 'png')).toMatchObject({ ok: false, code: 'invalid-image-binary' });
		expect(validateImage(gif().slice(0, -1), 'gif')).toMatchObject({ ok: false, code: 'invalid-image-binary' });
	});

	it('rejects PNG alpha channels and transparency chunks', () => {
		expect(validateImage(png(2, 3, 6), 'png')).toMatchObject({ ok: false, code: 'transparent-image' });
		expect(validateImage(png(2, 3, 2, [pngChunk('tRNS', [0, 0, 0, 0, 0, 0])]), 'png'))
			.toMatchObject({ ok: false, code: 'transparent-image' });
	});

	it('rejects APNG before transparent PNG conversion can run', () => {
		expect(validateImage(png(2, 3, 6, [pngChunk('acTL', [...u32(2), ...u32(0)])]), 'png'))
			.toMatchObject({ ok: false, code: 'animated-png' });
	});

	it('rejects animated and transparent GIF images', () => {
		expect(validateImage(gif(2), 'gif')).toMatchObject({ ok: false, code: 'animated-gif' });
		expect(validateImage(gif(1, true), 'gif')).toMatchObject({ ok: false, code: 'transparent-image' });
	});

	it('rejects unsupported formats, excessive dimensions and excessive bytes', () => {
		expect(validateImage(new Uint8Array([1, 2, 3]), 'webp')).toMatchObject({
			ok: false,
			code: 'unsupported-image-format',
		});
		expect(validateImage(png(10_000, 5_000), 'png')).toMatchObject({ ok: false, code: 'image-too-large' });
		expect(validateImage(new Uint8Array(MAX_IMAGE_BYTES + 1), 'jpg')).toMatchObject({
			ok: false,
			code: 'image-too-large',
		});
	});

	it('rejects PNG chunks with invalid CRCs', () => {
		const corrupted = png();
		corrupted[29] = (corrupted[29] ?? 0) ^ 0xff;
		expect(validateImage(corrupted, 'png')).toMatchObject({ ok: false, code: 'invalid-image-binary' });
	});

	it('rejects empty PNG data, invalid GIF LZW sizes, and JPEGs without scans', () => {
		const emptyPng = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			...pngChunk('IHDR', [...u32(1), ...u32(1), 8, 2, 0, 0, 0]),
			...pngChunk('IDAT', []),
			...pngChunk('IEND', []),
		]);
		expect(validateImage(emptyPng, 'png')).toMatchObject({ ok: false, code: 'invalid-image-binary' });

		const invalidGif = gif();
		invalidGif[23] = 0;
		expect(validateImage(invalidGif, 'gif')).toMatchObject({ ok: false, code: 'invalid-image-binary' });

		const noScanJpeg = new Uint8Array([
			0xff, 0xd8,
			0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00,
			0xff, 0xd9,
		]);
		expect(validateImage(noScanJpeg, 'jpg')).toMatchObject({ ok: false, code: 'invalid-image-binary' });
	});

	it('rejects forbidden, duplicate, and oversized PNG palettes', () => {
		const palette = pngChunk('PLTE', [0, 0, 0, 255, 255, 255]);
		expect(validateImage(png(2, 3, 0, [palette]), 'png')).toMatchObject({
			ok: false,
			code: 'invalid-image-binary',
		});
		expect(validateImage(png(2, 3, 2, [palette, palette]), 'png')).toMatchObject({
			ok: false,
			code: 'invalid-image-binary',
		});
		const threeEntries = pngChunk('PLTE', [0, 0, 0, 127, 127, 127, 255, 255, 255]);
		expect(validateImage(png(2, 3, 3, [threeEntries], 1), 'png')).toMatchObject({
			ok: false,
			code: 'invalid-image-binary',
		});
	});

	it('requires JPEG scans to follow SOF and reference declared components', () => {
		const valid = jpeg();
		const mismatched = new Uint8Array(valid);
		mismatched[20] = 2;
		expect(validateImage(mismatched, 'jpg')).toMatchObject({ ok: false, code: 'invalid-image-binary' });

		const sosBeforeSof = new Uint8Array([
			0xff, 0xd8,
			0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
			0x12,
			0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00,
			0xff, 0xd9,
		]);
		expect(validateImage(sosBeforeSof, 'jpg')).toMatchObject({ ok: false, code: 'invalid-image-binary' });
	});
});
