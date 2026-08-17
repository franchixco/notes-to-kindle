import type { App, CachedMetadata, EmbedCache, TFile } from 'obsidian';
import { Marked, type Token, type Tokens } from 'marked';
import {
	MAX_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	MAX_EMBED_REFERENCES,
	MAX_EXPANDED_NOTES,
	MAX_TOTAL_MARKDOWN_BYTES,
	type EpubImageAsset,
	type ImageWarning,
	type RemoteImageReference,
} from '../images/types';
import {
	fetchRemoteImage,
	MAX_REMOTE_IMAGES,
	RemoteImageFetchError,
	type RemoteImageResponse,
} from '../images/remote-fetch';
import { ImageAssetRegistry } from './image-assets';

export interface ExtractedNote {
	title: string;
	bodyMarkdown: string;
	embeds: Array<{ path: string; kind: 'image' | 'note' }>;
	assets?: EpubImageAsset[];
	warnings?: ImageWarning[];
	remoteImageMap?: ReadonlyMap<string, string>;
	remoteImageCount?: number;
}

export interface PreparedNote {
	note: ExtractedNote;
	remoteImages: readonly RemoteImageReference[];
	includeRemoteImages(signal?: AbortSignal): Promise<ExtractedNote>;
}

export type RemoteImageLoader = (
	href: string,
	maxBytes: number,
	signal: AbortSignal | undefined,
	deadlineAt: number,
) => Promise<RemoteImageResponse>;

type Embed = { path: string; kind: 'image' | 'note' };
type Replacement = { start: number; end: number; value: string };
type ExtractionBudget = { references: number; notes: number; markdownBytes: number };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif']);
const KNOWN_IMAGE_EXTS = new Set([...IMAGE_EXTS, 'webp', 'svg', 'bmp', 'tif', 'tiff', 'heic', 'avif']);
const MAX_EMBED_DEPTH = 3;

function stripFrontmatter(md: string, cache: CachedMetadata | null): string {
	const position = cache?.frontmatterPosition;
	if (position && position.start.offset >= 0 && position.end.offset <= md.length) {
		return md.slice(0, position.start.offset) + md.slice(position.end.offset);
	}
	return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '');
}

function extOf(target: string): string {
	const path = target.split('#', 1)[0] ?? '';
	const dot = path.lastIndexOf('.');
	if (dot < 0) return '';
	const ext = path.slice(dot + 1).toLowerCase();
	return /[^\w]/.test(ext) ? '' : ext;
}

function linkPath(target: string): string {
	return (target.split('#', 1)[0] ?? '').trim();
}

function isExternalTarget(target: string): boolean {
	const value = target.trim();
	return value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function imageAlt(embed: EmbedCache, resolved: TFile | null): string {
	const display = embed.displayText?.trim();
	if (display && !/^\d+(?:x\d+)?$/i.test(display)) return display;
	if (resolved?.basename) return resolved.basename;
	const path = linkPath(embed.link).replace(/\\/g, '/');
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.replace(/\.[^.]+$/, '') || 'image';
}

function escapeMarkdownAlt(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function omittedImage(alt: string): string {
	const safeAlt = alt.replaceAll('[', ' ').replaceAll(']', ' ').replace(/[\r\n]/g, ' ').trim();
	return `[Image omitted: ${safeAlt || 'image'}]`;
}

function validRange(embed: EmbedCache, raw: string): boolean {
	const { start, end } = embed.position;
	return start.offset >= 0 && end.offset > start.offset && end.offset <= raw.length
		&& raw.slice(start.offset, end.offset) === embed.original;
}

function applyReplacements(raw: string, replacements: Replacement[]): string {
	let result = raw;
	const ordered = replacements.sort((left, right) => right.start - left.start);
	let previousStart = raw.length;
	for (const replacement of ordered) {
		if (replacement.end > previousStart) continue;
		result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
		previousStart = replacement.start;
	}
	return result;
}

function notFoundWarning(sourcePath: string, target: string): ImageWarning {
	return {
		code: 'image-not-found',
		sourcePath,
		target,
		message: 'A local image reference could not be resolved.',
	};
}

async function processNote(
	app: App,
	file: TFile,
	embeds: Embed[],
	registry: ImageAssetRegistry,
	depth: number,
	activePaths: Set<string>,
	budget: ExtractionBudget,
): Promise<string> {
	if (file.stat.size > MAX_TOTAL_MARKDOWN_BYTES - budget.markdownBytes) {
		throw new Error('Embedded note content exceeds the 5 MiB safety limit.');
	}
	budget.markdownBytes += file.stat.size;
	const raw = await app.vault.read(file);
	const cache = app.metadataCache.getFileCache(file);
	if (depth >= MAX_EMBED_DEPTH) return stripFrontmatter(raw, cache);
	const cachedEmbeds = cache?.embeds ?? [];
	if (cachedEmbeds.length > MAX_EMBED_REFERENCES - budget.references) {
		throw new Error('The note exceeds the 2,000 embed reference safety limit.');
	}
	budget.references += cachedEmbeds.length;
	const replacements: Replacement[] = [];

	for (const cached of cachedEmbeds) {
		if (!validRange(cached, raw)) continue;
		const frontmatter = cache?.frontmatterPosition;
		if (frontmatter && cached.position.start.offset >= frontmatter.start.offset
			&& cached.position.end.offset <= frontmatter.end.offset) continue;
		const target = linkPath(cached.link);
		if (!target || isExternalTarget(target)) continue;
		const resolved = app.metadataCache.getFirstLinkpathDest(target, file.path);
		const ext = resolved?.extension.toLowerCase() ?? extOf(target);

		if (resolved && resolved.extension === 'md') {
			if (activePaths.has(resolved.path)) continue;
			if (budget.notes >= MAX_EXPANDED_NOTES) {
				throw new Error('The note exceeds the 256 expanded-note safety limit.');
			}
			budget.notes += 1;
			embeds.push({ path: resolved.path, kind: 'note' });
			const branch = new Set(activePaths);
			branch.add(resolved.path);
			const nested = await processNote(app, resolved, embeds, registry, depth + 1, branch, budget);
			replacements.push({
				start: cached.position.start.offset,
				end: cached.position.end.offset,
				value: `\n${nested}\n`,
			});
			continue;
		}

		if (resolved && ext !== 'md' && (IMAGE_EXTS.has(ext) || KNOWN_IMAGE_EXTS.has(ext))) {
			embeds.push({ path: resolved.path, kind: 'image' });
			const alt = imageAlt(cached, resolved);
			const registration = await registry.register(app, resolved, file.path, cached.link);
			if (registration.ok) {
				replacements.push({
					start: cached.position.start.offset,
					end: cached.position.end.offset,
					value: `![${escapeMarkdownAlt(alt)}](${registration.asset.href})`,
				});
			} else {
				registry.addWarning(registration.warning);
				replacements.push({
					start: cached.position.start.offset,
					end: cached.position.end.offset,
					value: omittedImage(alt),
				});
			}
			continue;
		}

		if (!resolved && KNOWN_IMAGE_EXTS.has(ext)) {
			const alt = imageAlt(cached, null);
			registry.addWarning(notFoundWarning(file.path, cached.link));
			replacements.push({
				start: cached.position.start.offset,
				end: cached.position.end.offset,
				value: omittedImage(alt),
			});
		}
	}

	return stripFrontmatter(applyReplacements(raw, replacements), cache);
}

function normalizeWikilinks(md: string): string {
	return md.replace(/\[\[([^\]]+)\]\]/g, (_: string, content: string) => {
		const parts = content.split('|');
		const alias = parts[1]?.trim();
		return alias ?? parts[0]?.trim() ?? '';
	});
}

function flattenCallouts(md: string): string {
	const pattern = /^> \[!(\w+)\](.*?)$(\n^>(.*)$)*/gm;
	return md.replace(pattern, (block: string, _type: string, rawTitle: string) => {
		const lines = block.split('\n');
		const body = lines.slice(1).map((line) => line.replace(/^> ?/, '')).join('\n').trim();
		const title = rawTitle.trim();
		return title ? `**${title}**\n\n${body}` : body;
	});
}

export function collectRemoteImageReferences(markdown: string): {
	references: RemoteImageReference[];
	overflow: boolean;
} {
	const marked = new Marked({ gfm: true });
	const tokens = marked.lexer(markdown);
	const seen = new Set<string>();
	const references: RemoteImageReference[] = [];
	let overflow = false;
	void marked.walkTokens(tokens, (token: Token) => {
		if (token.type !== 'image') return;
		const href = (token as Tokens.Image).href.trim();
		let protocol: string;
		try {
			protocol = new URL(href).protocol;
		} catch {
			return;
		}
		if (protocol !== 'https:' || seen.has(href)) return;
		seen.add(href);
		if (references.length < MAX_REMOTE_IMAGES) references.push({ href });
		else overflow = true;
	});
	return { references, overflow };
}

function remoteWarning(sourcePath: string, target: string, error: unknown): ImageWarning {
	const message = error instanceof RemoteImageFetchError
		? `Remote image was omitted (${error.code}).`
		: 'Remote image was omitted because its download failed.';
	return { code: 'remote-image-failed', sourcePath, target, message };
}

const defaultRemoteImageLoader: RemoteImageLoader = (href, maxBytes, signal, deadlineAt) => fetchRemoteImage(
	href,
	{ maxBytes, signal, deadlineAt },
);

export async function prepareNote(
	app: App,
	file: TFile,
	remoteImageLoader: RemoteImageLoader = defaultRemoteImageLoader,
): Promise<PreparedNote> {
	const embeds: Embed[] = [];
	const registry = new ImageAssetRegistry();
	const budget: ExtractionBudget = { references: 0, notes: 1, markdownBytes: 0 };
	let md = await processNote(app, file, embeds, registry, 0, new Set([file.path]), budget);
	md = normalizeWikilinks(md);
	md = flattenCallouts(md);
	const discovered = collectRemoteImageReferences(md);
	if (discovered.overflow) {
		registry.addWarning({
			code: 'remote-image-failed',
			sourcePath: file.path,
			target: 'remote images after the first 20',
			message: 'Remote images after the first 20 were omitted.',
		});
	}
	const baseNote: ExtractedNote = {
		title: file.basename,
		bodyMarkdown: md.trim(),
		embeds,
		assets: registry.assets(),
		warnings: registry.warnings(),
	};
	let included: Promise<ExtractedNote> | null = null;
	return {
		note: baseNote,
		remoteImages: discovered.references,
		includeRemoteImages(signal?: AbortSignal): Promise<ExtractedNote> {
			if (included) return included;
			included = (async () => {
				const remoteImageMap = new Map<string, string>();
				let remainingDownloadBytes = Math.min(MAX_TOTAL_IMAGE_BYTES, registry.remainingTotalBytes());
				const deadlineAt = Date.now() + 15_000;
				for (const reference of discovered.references) {
					if (signal?.aborted) throw new DOMException('Remote image download cancelled.', 'AbortError');
					if (Date.now() >= deadlineAt) {
						registry.addWarning(remoteWarning(
							file.path,
							reference.href,
							new RemoteImageFetchError('timeout', 'Remote image phase timed out.'),
						));
						continue;
					}
					if (remainingDownloadBytes <= 0) {
						registry.addWarning({
							code: 'image-budget-exceeded',
							sourcePath: file.path,
							target: reference.href,
							message: 'Remote image was omitted because the image budget is exhausted.',
						});
						continue;
					}
					try {
						const response = await remoteImageLoader(
							reference.href,
							Math.min(MAX_IMAGE_BYTES, remainingDownloadBytes),
							signal,
							deadlineAt,
						);
						remainingDownloadBytes -= response.data.byteLength;
						const registration = await registry.registerRemote(
							response.data,
							response.mediaType,
							file.path,
							reference.href,
							response.finalUrl,
						);
						if (registration.ok) remoteImageMap.set(reference.href, registration.asset.href);
						else registry.addWarning(registration.warning);
					} catch (error) {
						if (signal?.aborted) throw new DOMException('Remote image download cancelled.', 'AbortError');
						registry.addWarning(remoteWarning(file.path, reference.href, error));
					}
				}
				return {
					...baseNote,
					assets: registry.assets(),
					warnings: registry.warnings(),
					remoteImageMap,
					remoteImageCount: remoteImageMap.size,
				};
			})();
			return included;
		},
	};
}

export async function extractNote(app: App, file: TFile): Promise<ExtractedNote> {
	return (await prepareNote(app, file)).note;
}
