import type { ExtractedNote } from '../obsidian-extract/extract';

export interface EpubOptions {
	title: string;
	author: string;
}

export async function buildEpub(note: ExtractedNote, opts: EpubOptions): Promise<ArrayBuffer> {
	throw new Error('not implemented');
}
