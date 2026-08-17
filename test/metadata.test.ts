import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;
}

function listProjectFiles(): string[] {
	const excluded = new Set(['node_modules', '.git', 'main.js', 'bun.lock', 'data.json']);
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			if (excluded.has(entry)) continue;
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
			} else {
				files.push(relative(ROOT, full));
			}
		}
	};
	walk(ROOT);
	return files;
}

const fileContent = (path: string): string =>
	readFileSync(join(ROOT, path), 'utf8');

// Lowercase `send-to-kindle` is permitted only where it is historically
// meaningful: the preserved SecretStorage keys and their tests, the negative
// User-Agent test, the 0.1.1 release mapping, and migration documentation.
const ALLOWED_SEND_TO_KINDLE = new Set([
	'src/stk/credentials.ts',
	'test/credentials.test.ts',
	'test/user-agent.test.ts',
	'test/metadata.test.ts',
	'README.md',
	'AGENTS.md',
	'.github/workflows/release.yml',
]);

describe('identity metadata (0.1.4)', () => {
	it('manifest.json declares the notes-to-kindle identity for 0.1.4', () => {
		const manifest = readJson('manifest.json');
		expect(manifest.id).toBe('notes-to-kindle');
		expect(manifest.name).toBe('Notes to Kindle');
		expect(manifest.version).toBe('0.1.4');
		expect(manifest.minAppVersion).toBe('1.11.4');
		expect(manifest.isDesktopOnly).toBe(true);
	});

	it('package.json matches the manifest and points at the notes-to-kindle repo', () => {
		const pkg = readJson('package.json');
		const manifest = readJson('manifest.json');
		expect(pkg.name).toBe('notes-to-kindle');
		expect(pkg.version).toBe(manifest.version);
		expect(pkg.repository).toBe('https://github.com/franchixco/notes-to-kindle');
		expect(pkg.keywords).toContain('notes-to-kindle');
		expect(pkg.keywords).not.toContain('send-to-kindle');
		expect(pkg.dependencies).toHaveProperty('fflate');
		expect(pkg.dependencies).not.toHaveProperty('jszip');
	});

	it('versions.json preserves release history and adds 0.1.4', () => {
		const versions = readJson('versions.json');
		expect(versions['0.1.0']).toBe('1.11.4');
		expect(versions['0.1.1']).toBe('1.11.4');
		expect(versions['0.1.2']).toBe('1.11.4');
		expect(versions['0.1.3']).toBe('1.11.4');
		expect(versions['0.1.4']).toBe('1.11.4');
	});

	it('esbuild banner names the notes-to-kindle repo', () => {
		const config = fileContent('esbuild.config.mjs');
		expect(config).toContain('Notes to Kindle');
		expect(config).toContain('https://github.com/franchixco/notes-to-kindle');
		expect(config).not.toContain('franchixco/send-to-kindle');
	});

	it('bun.lock workspace name matches the package name', () => {
		const lock = fileContent('bun.lock');
		expect(lock).toContain('"name": "notes-to-kindle"');
	});
});

describe('historical version mapping', () => {
	it('maps every release generation to its original plugin id', () => {
		const workflow = fileContent('.github/workflows/release.yml');
		expect(workflow).toContain('obsidian-kindle-stk');
		expect(workflow).toContain('send-to-kindle');
		expect(workflow).toContain('notes-to-kindle');
		expect(workflow).toContain('0.1.0');
		expect(workflow).toContain('0.1.1');
	});
});

describe('identity hygiene', () => {
	it('leaves no lowercase notes-to-ereader remnant anywhere', () => {
		const offenders = listProjectFiles()
			.filter((path) => path !== 'test/metadata.test.ts')
			.filter((path) => fileContent(path).includes('notes-to-ereader'));
		expect(offenders).toEqual([]);
	});

	it('restricts lowercase send-to-kindle to historically meaningful files', () => {
		const offenders = listProjectFiles().filter(
			(path) =>
				!ALLOWED_SEND_TO_KINDLE.has(path) && fileContent(path).includes('send-to-kindle'),
		);
		expect(offenders).toEqual([]);
	});
});
