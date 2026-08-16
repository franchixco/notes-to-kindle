import { describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempEpubFile } from '../src/epub/temp';

const MODE_0700 = 0o700;
const MODE_0600 = 0o600;

function modeOf(path: string): number {
	return lstatSync(path).mode & 0o777;
}

describe('createTempEpubFile', () => {
	it('writes the data into a fresh file with mode 0600', () => {
		const data = Buffer.from('epub-bytes');
		const temp = createTempEpubFile(data);
		try {
			expect(readFileSync(temp.path)).toEqual(data);
			expect(modeOf(temp.path)).toBe(MODE_0600);
		} finally {
			temp.cleanup();
		}
	});

	it('creates a private directory with mode 0700 under the temp root', () => {
		const temp = createTempEpubFile(Buffer.from('x'));
		try {
			const dir = temp.path.slice(0, temp.path.lastIndexOf('/'));
			const parent = dir.slice(0, dir.lastIndexOf('/'));
			expect(parent).toBe(tmpdir());
			expect(dir.startsWith(join(tmpdir(), 'obsidian-kindle-'))).toBe(true);
			expect(modeOf(dir)).toBe(MODE_0700);
		} finally {
			temp.cleanup();
		}
	});

	it('creates a unique directory per call', () => {
		const first = createTempEpubFile(Buffer.from('a'));
		const second = createTempEpubFile(Buffer.from('b'));
		try {
			expect(first.path).not.toBe(second.path);
			expect(first.path.slice(0, first.path.lastIndexOf('/'))).not.toBe(
				second.path.slice(0, second.path.lastIndexOf('/')),
			);
		} finally {
			first.cleanup();
			second.cleanup();
		}
	});

	it('cleans up the whole directory recursively', () => {
		const temp = createTempEpubFile(Buffer.from('x'));
		const dir = temp.path.slice(0, temp.path.lastIndexOf('/'));
		expect(existsSync(temp.path)).toBe(true);
		temp.cleanup();
		expect(existsSync(temp.path)).toBe(false);
		expect(existsSync(dir)).toBe(false);
	});

	it('cleanup is idempotent and never throws', () => {
		const temp = createTempEpubFile(Buffer.from('x'));
		temp.cleanup();
		expect(() => temp.cleanup()).not.toThrow();
		expect(() => temp.cleanup()).not.toThrow();
	});

	it('leaves no sibling files in the temp directory', () => {
		const temp = createTempEpubFile(Buffer.from('x'));
		try {
			const dir = temp.path.slice(0, temp.path.lastIndexOf('/'));
			expect(readdirSync(dir)).toEqual(['note.epub']);
		} finally {
			temp.cleanup();
		}
	});
});
