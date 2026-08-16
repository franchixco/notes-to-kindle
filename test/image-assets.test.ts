import { describe, expect, it } from 'bun:test';
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
		extension: 'jpg',
		stat: { size: declaredSize, ctime: 0, mtime: 0 },
	} as unknown as RegistryFile;
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
		});

		expect((await registry.register(app, file('first.jpg', firstBytes.byteLength), 'root.md', 'first.jpg')).ok)
			.toBe(true);
		const firstRace = await registry.register(app, file('race.jpg', 1), 'root.md', 'race.jpg');
		const secondRace = await registry.register(app, file('race.jpg', 1), 'root.md', 'race.jpg');
		expect(firstRace).toMatchObject({ ok: false, warning: { code: 'image-budget-exceeded' } });
		expect(secondRace).toMatchObject({ ok: false, warning: { code: 'image-budget-exceeded' } });
		expect(reads.get('race.jpg')).toBe(1);
	});
});
