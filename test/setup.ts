import { createRequire } from 'node:module';

// The production modules obtain Node built-ins through Obsidian's
// `window.require`. Under the Bun test runner there is no `window`, so we
// install a shim backed by `createRequire` before any test module is loaded.
const nodeRequire = createRequire(import.meta.url);

const windowWithRequire = {
	require: (id: string): unknown => nodeRequire(id) as unknown,
	setTimeout,
	clearTimeout,
};

(globalThis as unknown as { window?: unknown }).window = windowWithRequire;
