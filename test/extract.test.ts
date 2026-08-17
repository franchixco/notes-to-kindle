import { describe, expect, it } from 'bun:test';
import { posix } from 'node:path';
import {
	collectRemoteImageReferences,
	extractNote,
	prepareNote,
} from '../src/obsidian-extract/extract';
import { MAX_IMAGE_BYTES } from '../src/images/types';

type ExtractApp = Parameters<typeof extractNote>[0];
type ExtractFile = Parameters<typeof extractNote>[1];

interface FakeFileEntry {
	path: string;
	content?: string;
	binary?: Uint8Array;
	statSize?: number;
}

function extension(path: string): string {
	const dot = path.lastIndexOf('.');
	return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
}

function makeFakeFile(path: string, size = 0): ExtractFile {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const ext = extension(path);
	return {
		path,
		basename: ext ? name.slice(0, -(ext.length + 1)) : name,
		extension: ext,
		stat: { size, ctime: 0, mtime: 0 },
	} as unknown as ExtractFile;
}

function cacheEmbeds(content: string): Array<Record<string, unknown>> {
	const values: Array<Record<string, unknown>> = [];
	for (const match of content.matchAll(/!\[\[([^\]]+)\]\]/g)) {
		const original = match[0];
		const inner = match[1] ?? '';
		const [link = '', displayText] = inner.split('|');
		const start = match.index;
		values.push({
			link,
			original,
			displayText,
			position: {
				start: { line: 0, col: start, offset: start },
				end: { line: 0, col: start + original.length, offset: start + original.length },
			},
		});
	}
	for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g)) {
		const original = match[0];
		const start = match.index;
		values.push({
			link: match[2] ?? '',
			original,
			displayText: match[1] ?? '',
			position: {
				start: { line: 0, col: start, offset: start },
				end: { line: 0, col: start + original.length, offset: start + original.length },
			},
		});
	}
	return values.sort((left, right) => {
		const leftPosition = left.position as { start: { offset: number } };
		const rightPosition = right.position as { start: { offset: number } };
		return leftPosition.start.offset - rightPosition.start.offset;
	});
}

function resolveEntry(files: Map<string, FakeFileEntry>, link: string, sourcePath: string): FakeFileEntry | null {
	const sourceRelative = posix.normalize(posix.join(posix.dirname(sourcePath), link));
	const candidates = [link, sourceRelative, `${link}.md`, `${sourceRelative}.md`];
	for (const candidate of candidates) {
		const direct = files.get(candidate);
		if (direct) return direct;
	}
	const withoutMd = link.replace(/\.md$/, '');
	return [...files.values()].find((entry) => {
		const noExt = entry.path.replace(/\.md$/, '');
		return noExt === withoutMd || posix.basename(noExt) === withoutMd;
	}) ?? null;
}

function makeFakeApp(entries: FakeFileEntry[], reads?: { binary: number }, cacheOffsetShift = 0): ExtractApp {
	const files = new Map(entries.map((entry) => [entry.path, entry] as const));
	const app = {
		vault: {
			read: async (file: { path: string }): Promise<string> => {
				const entry = files.get(file.path);
				if (!entry || entry.content === undefined) throw new Error(`missing text file ${file.path}`);
				return entry.content;
			},
			readBinary: async (file: { path: string }): Promise<ArrayBuffer> => {
				if (reads) reads.binary += 1;
				const bytes = files.get(file.path)?.binary;
				if (!bytes) throw new Error(`missing binary file ${file.path}`);
				return new Uint8Array(bytes).buffer;
			},
		},
		metadataCache: {
			getFirstLinkpathDest: (link: string, sourcePath: string): ExtractFile | null => {
				const entry = resolveEntry(files, link, sourcePath);
				const size = entry?.statSize ?? entry?.binary?.byteLength ?? entry?.content?.length ?? 0;
				return entry ? makeFakeFile(entry.path, size) : null;
			},
			getFileCache: (file: { path: string }): Record<string, unknown> | null => {
				const content = files.get(file.path)?.content;
				if (content === undefined) return null;
				const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n*/.exec(content);
				const embeds = cacheEmbeds(content).map((embed) => {
					if (cacheOffsetShift === 0) return embed;
					const position = embed.position as {
						start: { line: number; col: number; offset: number };
						end: { line: number; col: number; offset: number };
					};
					return {
						...embed,
						position: {
							start: { ...position.start, offset: position.start.offset + cacheOffsetShift },
							end: { ...position.end, offset: position.end.offset + cacheOffsetShift },
						},
					};
				});
				return {
					embeds,
					frontmatterPosition: frontmatter ? {
						start: { line: 0, col: 0, offset: 0 },
						end: { line: 0, col: 0, offset: frontmatter[0].length },
					} : undefined,
				};
			},
		},
	};
	return app as unknown as ExtractApp;
}

function jpeg(): Uint8Array {
	return new Uint8Array([
		0xff, 0xd8,
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00,
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
		0x12, 0xff, 0x00, 0x34, 0xff, 0xd9,
	]);
}

describe('extractNote', () => {
	it('expands at most three nested note levels and records only notes actually read', async () => {
		const app = makeFakeApp([
			{ path: 'root.md', content: '![[b]]' },
			{ path: 'b.md', content: 'BB-body\n![[c]]' },
			{ path: 'c.md', content: 'CC-body\n![[d]]' },
			{ path: 'd.md', content: 'DD-body\n![[e]]\n![[pic.png]]' },
			{ path: 'e.md', content: 'EE-deepest' },
		]);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.bodyMarkdown).toContain('BB-body');
		expect(note.bodyMarkdown).toContain('CC-body');
		expect(note.bodyMarkdown).toContain('DD-body');
		expect(note.bodyMarkdown).not.toContain('EE-deepest');
		expect(note.bodyMarkdown).toContain('!e');
		expect(note.bodyMarkdown).toContain('!pic.png');
		expect(note.embeds).toEqual([
			{ path: 'b.md', kind: 'note' },
			{ path: 'c.md', kind: 'note' },
			{ path: 'd.md', kind: 'note' },
		]);
	});

	it('resolves wikilink and Markdown images against the note that contains them', async () => {
		const app = makeFakeApp([
			{ path: 'root.md', content: '![[nested/note]]' },
			{ path: 'nested/note.md', content: '![[../assets/photo.jpg|300x200]]\n![diagram](../assets/photo.jpg)' },
			{ path: 'assets/photo.jpg', binary: jpeg() },
		]);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.assets).toHaveLength(1);
		expect(note.embeds).toEqual([
			{ path: 'nested/note.md', kind: 'note' },
			{ path: 'assets/photo.jpg', kind: 'image' },
			{ path: 'assets/photo.jpg', kind: 'image' },
		]);
		expect(note.bodyMarkdown).toContain('![photo](images/');
		expect(note.bodyMarkdown).toContain('![diagram](images/');
		expect(note.warnings).toEqual([]);
	});

	it('deduplicates equal image bytes across distinct vault paths', async () => {
		const bytes = jpeg();
		const app = makeFakeApp([
			{ path: 'root.md', content: '![[one.jpg]] ![[folder/two.jpg]]' },
			{ path: 'one.jpg', binary: bytes },
			{ path: 'folder/two.jpg', binary: bytes },
		]);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.assets).toHaveLength(1);
		expect(note.bodyMarkdown.match(/images\//g)?.length).toBe(2);
	});

	it('never reads remote images and keeps their safe alt text fallback', async () => {
		const reads = { binary: 0 };
		const app = makeFakeApp([
			{ path: 'root.md', content: '![remote](https://example.com/a.jpg)' },
		], reads);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(reads.binary).toBe(0);
		expect(note.assets).toEqual([]);
		expect(note.bodyMarkdown).toContain('![remote](https://example.com/a.jpg)');
	});

	it('does not read an oversized image and reads repeated references only once', async () => {
		const oversizedReads = { binary: 0 };
		const oversized = makeFakeApp([
			{ path: 'root.md', content: '![[huge.jpg]]' },
			{ path: 'huge.jpg', binary: jpeg(), statSize: MAX_IMAGE_BYTES + 1 },
		], oversizedReads);
		const oversizedNote = await extractNote(oversized, makeFakeFile('root.md'));
		expect(oversizedReads.binary).toBe(0);
		expect(oversizedNote.warnings?.[0]?.code).toBe('image-too-large');

		const repeatedReads = { binary: 0 };
		const repeated = makeFakeApp([
			{ path: 'root.md', content: Array.from({ length: 50 }, () => '![[same.jpg]]').join('\n') },
			{ path: 'same.jpg', binary: jpeg() },
		], repeatedReads);
		const repeatedNote = await extractNote(repeated, makeFakeFile('root.md'));
		expect(repeatedReads.binary).toBe(1);
		expect(repeatedNote.assets).toHaveLength(1);
	});

	it('degrades missing and unsupported local images with warnings', async () => {
		const app = makeFakeApp([
			{ path: 'root.md', content: '![[missing.png|lost]] ![[vector.svg]]' },
			{ path: 'vector.svg', binary: new TextEncoder().encode('<svg/>') },
		]);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.bodyMarkdown).toContain('[Image omitted: lost]');
		expect(note.bodyMarkdown).toContain('[Image omitted: vector]');
		expect(note.warnings?.map((item) => item.code)).toEqual([
			'image-not-found',
			'unsupported-image-format',
		]);
	});

	it('does not expand cycles and strips frontmatter without shifting embed offsets', async () => {
		const app = makeFakeApp([
			{ path: 'root.md', content: '---\ncover: "![[ignored.jpg]]"\n---\n![[child]]' },
			{ path: 'child.md', content: 'child\n![[root]]' },
			{ path: 'ignored.jpg', binary: jpeg() },
		]);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.bodyMarkdown).toContain('child');
		expect(note.bodyMarkdown).toContain('!root');
		expect(note.bodyMarkdown).not.toContain('cover:');
		expect(note.assets).toEqual([]);
	});

	it('ignores stale cache offsets instead of replacing unrelated text', async () => {
		const app = makeFakeApp([
			{ path: 'root.md', content: 'PREFIX ![[child]]' },
			{ path: 'child.md', content: 'CHILD' },
		], undefined, -2);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.bodyMarkdown).toBe('PREFIX !child');
		expect(note.bodyMarkdown).not.toContain('CHILD');
		expect(note.embeds).toEqual([]);
	});

	it('aborts before processing an excessive number of embed references', async () => {
		const content = Array.from({ length: 2_001 }, () => '![[same.jpg]]').join('\n');
		const app = makeFakeApp([
			{ path: 'root.md', content },
			{ path: 'same.jpg', binary: jpeg() },
		]);
		let thrown: unknown;
		try {
			await extractNote(app, makeFakeFile('root.md'));
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		if (!(thrown instanceof Error)) throw new Error('Expected extraction to fail.');
		expect(thrown.message).toContain('2,000 embed reference safety limit');
	});

	it('leaves notes without embeds untouched', async () => {
		const app = makeFakeApp([{ path: 'root.md', content: 'solo texto' }]);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.bodyMarkdown).toBe('solo texto');
		expect(note.embeds).toEqual([]);
		expect(note.assets).toEqual([]);
		expect(note.warnings).toEqual([]);
	});
});

describe('remote image extraction', () => {
	it('collects inline and reference-style image tokens but excludes code and raw HTML', () => {
		const markdown = [
			'![inline](https://cdn.example/inline.png)',
			'![reference][photo]',
			'[photo]: https://cdn.example/reference.jpg',
			'`![code](https://cdn.example/code.png)`',
			'```md\n![fenced](https://cdn.example/fenced.png)\n```',
			'<img src="https://cdn.example/html.png">',
			'![http](http://cdn.example/insecure.png)',
		].join('\n\n');
		const result = collectRemoteImageReferences(markdown);
		expect(result.references.map((item) => item.href)).toEqual([
			'https://cdn.example/inline.png',
			'https://cdn.example/reference.jpg',
		]);
		expect(result.overflow).toBe(false);
	});

	it('discovers remote images after expanding embedded notes', async () => {
		const prepared = await prepareNote(makeFakeApp([
			{ path: 'root.md', content: '![[nested]]' },
			{ path: 'nested.md', content: '![nested remote](https://cdn.example/nested.jpg)' },
		]), makeFakeFile('root.md'));
		expect(prepared.remoteImages).toEqual([{ href: 'https://cdn.example/nested.jpg' }]);
	});

	it('does not call the loader before opt-in and registers approved bytes', async () => {
		let calls = 0;
		const app = makeFakeApp([{
			path: 'root.md',
			content: '![remote](https://cdn.example/photo.jpg "Remote title")',
		}]);
		const prepared = await prepareNote(app, makeFakeFile('root.md'), async (href, maxBytes) => {
			calls += 1;
			expect(href).toBe('https://cdn.example/photo.jpg');
			expect(maxBytes).toBe(MAX_IMAGE_BYTES);
			return { data: jpeg(), mediaType: 'image/jpeg', finalUrl: href };
		});
		expect(calls).toBe(0);
		expect(prepared.remoteImages).toEqual([{ href: 'https://cdn.example/photo.jpg' }]);

		const note = await prepared.includeRemoteImages();
		expect(calls).toBe(1);
		expect(note.assets).toHaveLength(1);
		expect(note.remoteImageMap?.get('https://cdn.example/photo.jpg')).toMatch(/^images\//);
		expect(note.remoteImageCount).toBe(1);
		expect(note.warnings).toEqual([]);
	});

	it('omits failed downloads without aborting the note', async () => {
		const app = makeFakeApp([{
			path: 'root.md',
			content: 'before ![remote](https://cdn.example/photo.jpg) after',
		}]);
		const prepared = await prepareNote(app, makeFakeFile('root.md'), async () => {
			throw new Error('secret transport detail');
		});
		const note = await prepared.includeRemoteImages();
		expect(note.bodyMarkdown).toContain('![remote](https://cdn.example/photo.jpg)');
		expect(note.assets).toEqual([]);
		expect(note.warnings?.[0]).toMatchObject({
			code: 'remote-image-failed',
			message: 'Remote image was omitted because its download failed.',
		});
	});

	it('caps unique remote references at twenty before any network work', async () => {
		const content = Array.from(
			{ length: 25 },
			(_, index) => `![remote ${index}](https://cdn.example/${index}.jpg)`,
		).join('\n');
		let calls = 0;
		const prepared = await prepareNote(
			makeFakeApp([{ path: 'root.md', content }]),
			makeFakeFile('root.md'),
			async (href) => { calls += 1; return { data: jpeg(), mediaType: 'image/jpeg', finalUrl: href }; },
		);
		expect(prepared.remoteImages).toHaveLength(20);
		const note = await prepared.includeRemoteImages();
		expect(calls).toBe(20);
		expect(note.remoteImageCount).toBe(20);
		expect(note.warnings?.some((item) => item.message.includes('after the first 20'))).toBe(true);
	});

	it('aborts the whole remote phase without continuing to later references', async () => {
		const controller = new AbortController();
		let calls = 0;
		const prepared = await prepareNote(makeFakeApp([{
			path: 'root.md',
			content: '![one](https://cdn.example/one.jpg) ![two](https://cdn.example/two.jpg)',
		}]), makeFakeFile('root.md'), async (_href, _maxBytes, signal) => {
			calls += 1;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
			});
		});
		const inclusion = prepared.includeRemoteImages(controller.signal);
		controller.abort();
		let thrown: unknown;
		try { await inclusion; } catch (error) { thrown = error; }
		expect(thrown).toMatchObject({ name: 'AbortError' });
		expect(calls).toBe(1);
	});
});
