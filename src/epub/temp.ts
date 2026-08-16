import type fs from 'fs';
import type os from 'os';
import type path from 'path';

const nodeFs = window.require('fs') as typeof fs;
const nodeOs = window.require('os') as typeof os;
const nodePath = window.require('path') as typeof path;

export interface TempEpubFile {
	path: string;
	cleanup: () => void;
}

/**
 * Creates a private per-send temp directory (0700) and writes the EPUB into it
 * exclusively with mode 0600. The caller must call `cleanup` to remove the
 * whole directory recursively and forcefully, and `cleanup` is safe to call
 * more than once.
 */
export function createTempEpubFile(data: Uint8Array): TempEpubFile {
	const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'obsidian-kindle-'));
	nodeFs.chmodSync(dir, 0o700);

	const filePath = nodePath.join(dir, 'note.epub');
	try {
		nodeFs.writeFileSync(filePath, Buffer.from(data), { mode: 0o600, flag: 'wx' });
	} catch (err) {
		try {
			nodeFs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup of a half-created temp dir.
		}
		throw err;
	}

	return {
		path: filePath,
		cleanup: () => {
			try {
				nodeFs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup; never throw out of the send path.
			}
		},
	};
}
