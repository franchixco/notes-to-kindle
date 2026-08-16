import { describe, expect, it } from 'bun:test';
import { extractNote } from '../src/obsidian-extract/extract';

// Structural fakes for the Obsidian surface, bridged through `unknown` so no
// Obsidian runtime is needed. The casts go through an alias of the extract
// signatures so the plugin lint rule banning direct `as TFile` casts is not
// triggered in the tests.
type ExtractApp = Parameters<typeof extractNote>[0];
type ExtractFile = Parameters<typeof extractNote>[1];

interface FakeFileEntry {
	path: string;
	content: string;
}

function makeFakeFile(path: string): ExtractFile {
	return {
		path,
		basename: path.replace(/\.md$/, ''),
		extension: 'md',
	} as unknown as ExtractFile;
}

function makeFakeApp(files: FakeFileEntry[]): ExtractApp {
	const byPath = new Map(files.map((file) => [file.path, file] as const));
	const byBasename = new Map(files.map((file) => [file.path.replace(/\.md$/, ''), file] as const));
	const app = {
		vault: {
			read: async (file: unknown): Promise<string> => {
				const target = file as { path: string };
				const entry = byPath.get(target.path);
				if (!entry) throw new Error(`missing vault file ${target.path}`);
				return entry.content;
			},
		},
		metadataCache: {
			getFirstLinkpathDest: (link: unknown, _sourcePath: unknown): unknown => {
				const name = String(link).replace(/\.md$/, '');
				const entry = byBasename.get(name);
				if (!entry) return null;
				return { path: entry.path, extension: 'md', basename: name };
			},
		},
	};
	return app as unknown as ExtractApp;
}

describe('extractNote embed depth', () => {
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
		// The fourth level stays as unexpanded literal embed wikilinks.
		expect(note.bodyMarkdown).toContain('!e');
		expect(note.bodyMarkdown).toContain('!pic.png');

		expect(note.embeds).toEqual([
			{ path: 'b.md', kind: 'note' },
			{ path: 'c.md', kind: 'note' },
			{ path: 'd.md', kind: 'note' },
		]);
	});

	it('records the images found within the expanded levels', async () => {
		const app = makeFakeApp([
			{ path: 'root.md', content: '![[b]]' },
			{ path: 'b.md', content: 'texto\n![[photo.png]]' },
		]);

		const note = await extractNote(app, makeFakeFile('root.md'));

		expect(note.embeds).toEqual([
			{ path: 'b.md', kind: 'note' },
			{ path: 'photo.png', kind: 'image' },
		]);
		expect(note.bodyMarkdown).toContain('texto');
	});

	it('leaves notes without embeds untouched', async () => {
		const app = makeFakeApp([{ path: 'root.md', content: 'solo texto' }]);
		const note = await extractNote(app, makeFakeFile('root.md'));
		expect(note.bodyMarkdown).toBe('solo texto');
		expect(note.embeds).toEqual([]);
	});
});
