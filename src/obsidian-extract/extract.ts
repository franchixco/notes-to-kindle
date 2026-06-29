import type { TFile, App } from 'obsidian';

export interface ExtractedNote {
	title: string;
	bodyMarkdown: string;
	embeds: Array<{ path: string; kind: 'image' | 'note' }>;
}

export async function extractNote(app: App, file: TFile): Promise<ExtractedNote> {
	throw new Error('not implemented');
}
