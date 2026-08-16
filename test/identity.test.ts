import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

function readJsonFromRoot(relative: string): Record<string, unknown> {
	const path = new URL(`../${relative}`, import.meta.url);
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const pkg = readJsonFromRoot('package.json');
const manifest = readJsonFromRoot('manifest.json');
const versions = readJsonFromRoot('versions.json');

describe('plugin identity (0.1.2 notes-to-ereader)', () => {
	it('uses the community technical id notes-to-ereader everywhere', () => {
		expect(manifest.id).toBe('notes-to-ereader');
		expect(pkg.name).toBe('notes-to-ereader');
	});

	it('keeps the user-facing display name and desktop-only constraints', () => {
		expect(manifest.name).toBe('Notes to E-reader');
		expect(manifest.minAppVersion).toBe('1.11.4');
		expect(manifest.isDesktopOnly).toBe(true);
	});

	it('synchronizes version 0.1.2 across manifest, package and versions.json', () => {
		expect(manifest.version).toBe('0.1.2');
		expect(pkg.version).toBe('0.1.2');
		expect(versions['0.1.2']).toBe('1.11.4');
	});

	it('preserves the historical versions entries', () => {
		expect(versions['0.1.0']).toBe('1.11.4');
		expect(versions['0.1.1']).toBe('1.11.4');
	});

	it('points the package repository at the renamed repository', () => {
		expect(pkg.repository).toBe('https://github.com/franchixco/notes-to-ereader');
	});
});
