import type { App, TFile } from 'obsidian';

export interface ExtractedNote {
	title: string;
	bodyMarkdown: string;
	embeds: Array<{ path: string; kind: 'image' | 'note' }>;
}

type Embed = { path: string; kind: 'image' | 'note' };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function stripFrontmatter(md: string): string {
	return md.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

function extOf(target: string): string {
	const dot = target.lastIndexOf('.');
	if (dot < 0) return '';
	const ext = target.slice(dot + 1).toLowerCase();
	return /[^\w]/.test(ext) ? '' : ext;
}

async function resolveNoteEmbeds(
	app: App,
	md: string,
	embeds: Embed[],
	sourcePath: string,
	depth = 0,
): Promise<string> {
	if (depth > 3) return md;

	const pattern = /!\[\[([^\]]+)\]\]/g;
	const matches = [...md.matchAll(pattern)];

	let result = md;
	for (const match of matches) {
		const raw = match[1] ?? '';
		const target = raw.split('|')[0]?.trim() ?? '';
		if (!target) continue;
		const ext = extOf(target);

		if (ext === 'md' || ext === '') {
			const noteName = ext === 'md' ? target : `${target}.md`;
			const embeddedFile = app.metadataCache.getFirstLinkpathDest(noteName, sourcePath);
			if (embeddedFile && embeddedFile.extension === 'md') {
				embeds.push({ path: embeddedFile.path, kind: 'note' });
				const content = await app.vault.read(embeddedFile);
				const cleaned = stripFrontmatter(content);
				const resolved = await resolveNoteEmbeds(
					app,
					cleaned,
					embeds,
					embeddedFile.path,
					depth + 1,
				);
				result = result.replace(match[0], `\n${resolved}\n`);
			}
		} else if (IMAGE_EXTS.has(ext)) {
			embeds.push({ path: target, kind: 'image' });
		}
	}

	return result;
}

function normalizeWikilinks(md: string): string {
	return md.replace(/\[\[([^\]]+)\]\]/g, (_: string, content: string) => {
		const parts = content.split('|');
		const alias = parts[1]?.trim();
		return alias ?? parts[0]?.trim() ?? '';
	});
}

// Flatten Obsidian callouts (> [!type] title / > body) into bold title + plain body.
function flattenCallouts(md: string): string {
	const pattern = /^> \[!(\w+)\](.*?)$(\n^>(.*)$)*/gm;
	return md.replace(pattern, (block: string, _type: string, rawTitle: string) => {
		const lines = block.split('\n');
		const body = lines
			.slice(1)
			.map((line) => line.replace(/^> ?/, ''))
			.join('\n')
			.trim();
		const title = rawTitle.trim();
		return title ? `**${title}**\n\n${body}` : body;
	});
}

function convertHighlights(md: string): string {
	return md.replace(/==(.+?)==/g, (_: string, inner: string) => `<mark>${inner}</mark>`);
}

export async function extractNote(app: App, file: TFile): Promise<ExtractedNote> {
	const raw = await app.vault.read(file);
	const embeds: Embed[] = [];

	let md = stripFrontmatter(raw);
	md = await resolveNoteEmbeds(app, md, embeds, file.path);
	md = normalizeWikilinks(md);
	md = flattenCallouts(md);
	md = convertHighlights(md);

	return {
		title: file.basename,
		bodyMarkdown: md.trim(),
		embeds,
	};
}
