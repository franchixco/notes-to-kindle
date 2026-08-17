import { describe, expect, it } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { ImageConversionUnavailableError, type RasterToJpeg } from '../src/images/convert';
import { ImageAssetRegistry } from '../src/obsidian-extract/image-assets';

type RegistryApp = Parameters<ImageAssetRegistry['register']>[0];
type RegistryFile = Parameters<ImageAssetRegistry['register']>[1];

function jpeg(entropyByte: number): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8,
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00,
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
		entropyByte, 0xff, 0xd9,
	]);
}

function file(path: string, declaredSize: number): RegistryFile {
	return {
		path,
		basename: path.replace(/\.jpg$/, ''),
		extension: path.slice(path.lastIndexOf('.') + 1),
		stat: { size: declaredSize, ctime: 0, mtime: 0 },
	} as unknown as RegistryFile;
}

function u32be(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u32le(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(tag: string, payload: number[]): number[] {
	const tagBytes = [...new TextEncoder().encode(tag)];
	return [...u32be(payload.length), ...tagBytes, ...payload, ...u32be(crc32(new Uint8Array([...tagBytes, ...payload])))];
}

function transparentPng(animated = false, seed = 0): Uint8Array {
	const chunks = animated ? [pngChunk('acTL', [...u32be(2), ...u32be(0)])] : [];
	const scanlines = new Uint8Array(3 * (1 + 2 * 4));
	for (let row = 0; row < 3; row += 1) scanlines[row * (1 + 2 * 4)] = 0;
	scanlines[1] = seed & 0xff;
	return new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		...pngChunk('IHDR', [...u32be(2), ...u32be(3), 8, 6, 0, 0, 0]),
		...chunks.flat(),
		...pngChunk('IDAT', [...deflateSync(scanlines)]),
		...pngChunk('IEND', []),
	]);
}

function staticWebP(animated = false): Uint8Array {
	const vp8 = [
		...new TextEncoder().encode('VP8 '), ...u32le(10),
		0, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 3, 0,
	];
	const chunks = animated
		? [...new TextEncoder().encode('ANIM'), ...u32le(6), 0, 0, 0, 0, 0, 0, ...vp8]
		: vp8;
	const body = [...new TextEncoder().encode('WEBP'), ...chunks];
	return new Uint8Array([...new TextEncoder().encode('RIFF'), ...u32le(body.length), ...body]);
}

function appFor(binaries: Map<string, Uint8Array>, reads: Map<string, number>): RegistryApp {
	return {
		vault: {
			readBinary: async (target: { path: string }): Promise<ArrayBuffer> => {
				reads.set(target.path, (reads.get(target.path) ?? 0) + 1);
				const bytes = binaries.get(target.path);
				if (!bytes) throw new Error('missing test binary');
				return new Uint8Array(bytes).buffer;
			},
		},
	} as unknown as RegistryApp;
}

describe('ImageAssetRegistry', () => {
	it('caches a post-read budget rejection when stat size underestimates the bytes', async () => {
		const binaries = new Map([
			['first.jpg', jpeg(0x11)],
			['race.jpg', jpeg(0x22)],
		]);
		const reads = new Map<string, number>();
		const app = {
			vault: {
				readBinary: async (target: { path: string }): Promise<ArrayBuffer> => {
					reads.set(target.path, (reads.get(target.path) ?? 0) + 1);
					const bytes = binaries.get(target.path);
					if (!bytes) throw new Error('missing test binary');
					return new Uint8Array(bytes).buffer;
				},
			},
		} as unknown as RegistryApp;
		const firstBytes = binaries.get('first.jpg');
		if (!firstBytes) throw new Error('missing first fixture');
		const registry = new ImageAssetRegistry({
			maxImageBytes: 100,
			maxTotalBytes: firstBytes.byteLength + 1,
			maxUniqueImages: 10,
			maxConversions: 10,
		});

		expect((await registry.register(app, file('first.jpg', firstBytes.byteLength), 'root.md', 'first.jpg')).ok)
			.toBe(true);
		const firstRace = await registry.register(app, file('race.jpg', 1), 'root.md', 'race.jpg');
		const secondRace = await registry.register(app, file('race.jpg', 1), 'root.md', 'race.jpg');
		expect(firstRace).toMatchObject({ ok: false, warning: { code: 'image-budget-exceeded' } });
		expect(secondRace).toMatchObject({ ok: false, warning: { code: 'image-budget-exceeded' } });
		expect(reads.get('race.jpg')).toBe(1);
	});

	it('converts transparent PNG and static WebP to validated JPEG assets', async () => {
		const binaries = new Map([
			['alpha.png', transparentPng()],
			['static.webp', staticWebP()],
		]);
		const reads = new Map<string, number>();
		const calls: string[] = [];
		const converter: RasterToJpeg = {
			convert: async (_data, mediaType) => {
				calls.push(mediaType);
				return jpeg(mediaType === 'image/png' ? 0x44 : 0x45);
			},
		};
		const registry = new ImageAssetRegistry(undefined, converter);
		const app = appFor(binaries, reads);
		const pngResult = await registry.register(app, file('alpha.png', binaries.get('alpha.png')?.byteLength ?? 0), 'root.md', 'alpha.png');
		const webpResult = await registry.register(app, file('static.webp', binaries.get('static.webp')?.byteLength ?? 0), 'root.md', 'static.webp');
		expect(pngResult).toMatchObject({ ok: true, asset: { mediaType: 'image/jpeg', convertedFrom: 'image/png' } });
		expect(webpResult).toMatchObject({ ok: true, asset: { mediaType: 'image/jpeg', convertedFrom: 'image/webp' } });
		if (!pngResult.ok || !webpResult.ok) throw new Error('Expected converted assets.');
		expect(pngResult.asset.href).toMatch(/^images\/[0-9a-f]{64}\.jpg$/);
		expect(webpResult.asset.href).not.toBe(pngResult.asset.href);
		expect(calls).toEqual(['image/png', 'image/webp']);
	});

	it('rejects remote inputs that would require non-cancelable browser conversion', async () => {
		let calls = 0;
		const converter: RasterToJpeg = { convert: async () => { calls += 1; return jpeg(0x46); } };
		const registry = new ImageAssetRegistry(undefined, converter);
		const pngResult = await registry.registerRemote(
			transparentPng(),
			'image/png',
			'root.md',
			'https://cdn.example/alpha.png',
			'https://cdn.example/alpha.png',
		);
		const webpResult = await registry.registerRemote(
			staticWebP(),
			'image/webp',
			'root.md',
			'https://cdn.example/static.webp',
			'https://cdn.example/static.webp',
		);
		expect(pngResult).toMatchObject({ ok: false, warning: { code: 'unsupported-image-format' } });
		expect(webpResult).toMatchObject({ ok: false, warning: { code: 'unsupported-image-format' } });
		expect(calls).toBe(0);
	});

	it('rejects APNG and animated WebP without calling the converter', async () => {
		const binaries = new Map([
			['animated.png', transparentPng(true)],
			['animated.webp', staticWebP(true)],
		]);
		let calls = 0;
		const converter: RasterToJpeg = { convert: async () => { calls += 1; return jpeg(0x55); } };
		const registry = new ImageAssetRegistry(undefined, converter);
		const app = appFor(binaries, new Map());
		const pngResult = await registry.register(app, file('animated.png', binaries.get('animated.png')?.byteLength ?? 0), 'root.md', 'animated.png');
		const webpResult = await registry.register(app, file('animated.webp', binaries.get('animated.webp')?.byteLength ?? 0), 'root.md', 'animated.webp');
		expect(pngResult).toMatchObject({ ok: false, warning: { code: 'animated-png' } });
		expect(webpResult).toMatchObject({ ok: false, warning: { code: 'animated-webp' } });
		expect(calls).toBe(0);
	});

	it('caches conversion failures and distinguishes unavailable browser APIs', async () => {
		const bytes = transparentPng();
		const binaries = new Map([['alpha.png', bytes]]);
		const reads = new Map<string, number>();
		let calls = 0;
		const unavailable: RasterToJpeg = {
			convert: async () => {
				calls += 1;
				throw new ImageConversionUnavailableError('unavailable');
			},
		};
		const registry = new ImageAssetRegistry(undefined, unavailable);
		const app = appFor(binaries, reads);
		const target = file('alpha.png', bytes.byteLength);
		const first = await registry.register(app, target, 'root.md', 'alpha.png');
		const second = await registry.register(app, target, 'root.md', 'alpha.png');
		expect(first).toMatchObject({ ok: false, warning: { code: 'image-conversion-unavailable' } });
		expect(second).toMatchObject({ ok: false, warning: { code: 'image-conversion-unavailable' } });
		expect(calls).toBe(1);
		expect(reads.get('alpha.png')).toBe(1);
	});

	it('converts identical source bytes under different paths only once', async () => {
		const bytes = transparentPng();
		const binaries = new Map([['one.png', bytes], ['two.png', bytes]]);
		const reads = new Map<string, number>();
		let calls = 0;
		const converter: RasterToJpeg = { convert: async () => { calls += 1; return jpeg(0x66); } };
		const registry = new ImageAssetRegistry(undefined, converter);
		const app = appFor(binaries, reads);
		const first = await registry.register(app, file('one.png', bytes.byteLength), 'root.md', 'one.png');
		const second = await registry.register(app, file('two.png', bytes.byteLength), 'root.md', 'two.png');
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) throw new Error('Expected converted assets.');
		expect(second.asset.href).toBe(first.asset.href);
		expect(calls).toBe(1);
		expect(reads).toEqual(new Map([['one.png', 1], ['two.png', 1]]));
	});

	it('caps distinct conversion attempts at 100 even when outputs deduplicate', async () => {
		const binaries = new Map<string, Uint8Array>();
		for (let index = 0; index < 101; index += 1) binaries.set(`${index}.png`, transparentPng(false, index));
		let calls = 0;
		const converter: RasterToJpeg = { convert: async () => { calls += 1; return jpeg(0x77); } };
		const registry = new ImageAssetRegistry(undefined, converter);
		const app = appFor(binaries, new Map());
		let lastResult: Awaited<ReturnType<ImageAssetRegistry['register']>> | null = null;
		for (let index = 0; index < 101; index += 1) {
			const bytes = binaries.get(`${index}.png`);
			if (!bytes) throw new Error('missing fixture');
			lastResult = await registry.register(app, file(`${index}.png`, bytes.byteLength), 'root.md', `${index}.png`);
		}
		expect(calls).toBe(100);
		expect(lastResult).toMatchObject({ ok: false, warning: { code: 'image-budget-exceeded' } });
	});

	it('does not read or convert more images after the final-byte budget is exhausted', async () => {
		const firstBytes = transparentPng(false, 1);
		const secondBytes = transparentPng(false, 2);
		const output = jpeg(0x78);
		const binaries = new Map([['first.png', firstBytes], ['second.png', secondBytes]]);
		const reads = new Map<string, number>();
		let calls = 0;
		const converter: RasterToJpeg = { convert: async () => { calls += 1; return output; } };
		const registry = new ImageAssetRegistry({
			maxImageBytes: 1_000,
			maxTotalBytes: output.byteLength,
			maxUniqueImages: 100,
			maxConversions: 100,
		}, converter);
		const app = appFor(binaries, reads);
		const first = await registry.register(app, file('first.png', firstBytes.byteLength), 'root.md', 'first.png');
		const second = await registry.register(app, file('second.png', secondBytes.byteLength), 'root.md', 'second.png');
		expect(first.ok).toBe(true);
		expect(second).toMatchObject({ ok: false, warning: { code: 'image-budget-exceeded' } });
		expect(calls).toBe(1);
		expect(reads.get('second.png')).toBeUndefined();
	});
});
