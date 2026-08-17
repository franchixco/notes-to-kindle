import { describe, expect, it } from 'bun:test';
import { inspectStaticWebP } from '../src/images/webp';

function u16le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff];
}

function u24le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function u32le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function chunk(tag: string, payload: number[], pad = 0): number[] {
	return [
		...new TextEncoder().encode(tag),
		...u32le(payload.length),
		...payload,
		...(payload.length % 2 === 1 ? [pad] : []),
	];
}

function webp(...chunks: number[][]): Uint8Array {
	const body = [...new TextEncoder().encode('WEBP'), ...chunks.flat()];
	return new Uint8Array([...new TextEncoder().encode('RIFF'), ...u32le(body.length), ...body]);
}

function vp8(width: number, height: number): number[] {
	return chunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height)]);
}

function vp8l(width: number, height: number): number[] {
	const widthMinusOne = width - 1;
	const heightMinusOne = height - 1;
	return chunk('VP8L', [
		0x2f,
		widthMinusOne & 0xff,
		((widthMinusOne >>> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
		(heightMinusOne >>> 2) & 0xff,
		(heightMinusOne >>> 10) & 0x0f,
	]);
}

function vp8x(width: number, height: number, flags = 0): number[] {
	return chunk('VP8X', [flags, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1)]);
}

describe('inspectStaticWebP', () => {
	it('accepts static VP8, VP8L and extended WebP headers', () => {
		expect(inspectStaticWebP(webp(vp8(320, 200)))).toEqual({
			ok: true,
			info: { width: 320, height: 200, hasDeclaredAlpha: false, kind: 'vp8' },
		});
		expect(inspectStaticWebP(webp(vp8l(321, 201)))).toEqual({
			ok: true,
			info: { width: 321, height: 201, hasDeclaredAlpha: true, kind: 'vp8l' },
		});
		expect(inspectStaticWebP(webp(vp8x(320, 200, 0x10), vp8(320, 200)))).toEqual({
			ok: true,
			info: { width: 320, height: 200, hasDeclaredAlpha: true, kind: 'vp8x' },
		});
	});

	it('rejects animation flags and animation chunks before decoding', () => {
		expect(inspectStaticWebP(webp(vp8x(320, 200, 0x02), vp8(320, 200))))
			.toMatchObject({ ok: false, code: 'animated-webp' });
		expect(inspectStaticWebP(webp(chunk('ANIM', [0, 0, 0, 0, 0, 0]), vp8(320, 200))))
			.toMatchObject({ ok: false, code: 'animated-webp' });
	});

	it('rejects malformed sizes, padding, duplicate bitstreams and dimension mismatches', () => {
		const badRiff = webp(vp8(320, 200));
		badRiff[4] = 0;
		expect(inspectStaticWebP(badRiff)).toMatchObject({ ok: false, code: 'invalid-image-binary' });
		expect(inspectStaticWebP(webp(chunk('JUNK', [1], 1), vp8(320, 200))))
			.toMatchObject({ ok: false, code: 'invalid-image-binary' });
		expect(inspectStaticWebP(webp(vp8(320, 200), vp8l(320, 200))))
			.toMatchObject({ ok: false, code: 'invalid-image-binary' });
		expect(inspectStaticWebP(webp(vp8x(321, 200), vp8(320, 200))))
			.toMatchObject({ ok: false, code: 'invalid-image-binary' });
	});

	it('rejects excessive dimensions before browser decoding', () => {
		expect(inspectStaticWebP(webp(vp8(10_000, 5_000))))
			.toMatchObject({ ok: false, code: 'image-too-large' });
	});
});
