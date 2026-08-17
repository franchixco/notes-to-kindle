import type { ExtractedNote } from '../obsidian-extract/extract';
import type crypto from 'crypto';
import { strToU8, zipSync, type Zippable } from 'fflate';
import {
	MAX_EPUB_BYTES,
	MAX_IMAGE_BYTES,
	MAX_TOTAL_IMAGE_BYTES,
	MAX_UNIQUE_IMAGES,
	type EpubImageAsset,
	type SupportedImageMediaType,
} from '../images/types';
import { validateImage } from '../images/validate';
import { renderBodyHtml } from './render';
import { sanitizeXmlText } from './xml';

export interface EpubOptions {
	title: string;
	author: string;
}

function escapeXml(s: string): string {
	return sanitizeXmlText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
h1, h2, h3 { font-weight: bold; margin-top: 1em; }
h1 { font-size: 1.8em; }
h2 { font-size: 1.5em; }
h3 { font-size: 1.2em; }
p { margin: 0 0 0.5em 0; text-align: justify; }
code { font-family: monospace; font-size: 0.9em; }
pre { background: #eee; padding: 0.5em; overflow: hidden; page-break-inside: avoid; }
blockquote { margin: 0.5em 0; padding-left: 1em; border-left: 3px solid #ccc; }
img.stk-image { display: block; max-width: 100%; height: auto; object-fit: contain; margin: 0.5em auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #999; padding: 0.3em; }
`;

function buildContainerXml(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function buildOpf(
	title: string,
	author: string,
	bookId: string,
	modified: string,
	assets: readonly EpubImageAsset[],
): string {
	const t = escapeXml(title);
	const a = escapeXml(author);
	const imageItems = assets.map((asset) =>
		`    <item id="image-${asset.hash}" href="${escapeXml(asset.href)}" media-type="${asset.mediaType}"/>`,
	).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${t}</dc:title>
    <dc:creator>${a}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${imageItems ? `${imageItems}\n` : ''}  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>
`;
}

const MEDIA_EXTENSIONS: Record<SupportedImageMediaType, string> = {
	'image/jpeg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
};

function validateAssets(assets: readonly EpubImageAsset[], nodeCrypto: typeof crypto): EpubImageAsset[] {
	if (assets.length > MAX_UNIQUE_IMAGES) throw new Error('EPUB exceeds the 100 image safety limit.');
	const unique = new Map<string, EpubImageAsset>();
	let totalBytes = 0;
	for (const asset of assets) {
		if (asset.data.byteLength > MAX_IMAGE_BYTES) throw new Error('EPUB image exceeds the 10 MiB safety limit.');
		totalBytes += asset.data.byteLength;
		if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('EPUB images exceed the 50 MiB safety limit.');
		if (!/^[0-9a-f]{64}$/.test(asset.hash)) throw new Error('Invalid EPUB image hash.');
		const extension = MEDIA_EXTENSIONS[asset.mediaType];
		if (asset.href !== `images/${asset.hash}.${extension}`) throw new Error('Invalid EPUB image path.');
		const hash = nodeCrypto.createHash('sha256').update(asset.data).digest('hex');
		if (hash !== asset.hash) throw new Error('EPUB image hash does not match its bytes.');
		const validation = validateImage(asset.data, extension);
		if (!validation.ok || validation.image.mediaType !== asset.mediaType
			|| validation.image.width !== asset.width || validation.image.height !== asset.height) {
			throw new Error('EPUB image metadata does not match its bytes.');
		}
		const existing = unique.get(asset.href);
		if (existing && existing.hash !== asset.hash) throw new Error('Duplicate EPUB image path.');
		unique.set(asset.href, asset);
	}
	return [...unique.values()];
}

function buildNav(title: string): string {
	const t = escapeXml(title);
	return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${t}</title></head>
<body>
<nav epub:type="toc">
  <h1>${t}</h1>
  <ol><li><a href="chapter1.xhtml">${t}</a></li></ol>
</nav>
</body>
</html>
`;
}

function buildChapter(title: string, htmlBody: string): string {
	const t = escapeXml(title);
	return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${t}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${htmlBody}
</body>
</html>
`;
}

export async function buildEpub(note: ExtractedNote, opts: EpubOptions): Promise<ArrayBuffer> {
	const nodeCrypto = window.require('crypto') as typeof crypto;
	const bookId = nodeCrypto.randomUUID();
	const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
	const assets = validateAssets(note.assets ?? [], nodeCrypto);
	const htmlBody = renderBodyHtml(
		note.bodyMarkdown,
		new Set(assets.map((asset) => asset.href)),
		note.remoteImageMap,
	);

	// Object insertion order keeps mimetype as the first local file header. EPUB
	// additionally requires that entry to use STORE while the rest use DEFLATE.
	const files: Zippable = {
		mimetype: [strToU8('application/epub+zip'), { level: 0 }],
		'META-INF/container.xml': strToU8(buildContainerXml()),
		'OEBPS/content.opf': strToU8(buildOpf(opts.title, opts.author, bookId, modified, assets)),
		'OEBPS/nav.xhtml': strToU8(buildNav(opts.title)),
		'OEBPS/chapter1.xhtml': strToU8(buildChapter(opts.title, htmlBody)),
		'OEBPS/style.css': strToU8(CSS),
	};
	for (const asset of assets) files[`OEBPS/${asset.href}`] = [asset.data, { level: 0 }];
	const archive = zipSync(files, { level: 9 });
	if (archive.byteLength > MAX_EPUB_BYTES) throw new Error('The generated EPUB exceeds the 60 MiB safety limit.');
	return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
}
