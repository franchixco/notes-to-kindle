import type { ExtractedNote } from '../obsidian-extract/extract';
import type crypto from 'crypto';
import { renderBodyHtml } from './render';
import { sanitizeXmlText } from './xml';
import JSZip from 'jszip';

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
img { max-width: 100%; }
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

function buildOpf(title: string, author: string, bookId: string, modified: string): string {
	const t = escapeXml(title);
	const a = escapeXml(author);
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
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>
`;
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
	const htmlBody = renderBodyHtml(note.bodyMarkdown);

	const zip = new JSZip();
	// EPUB spec: mimetype must be the first entry and stored uncompressed.
	zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
	zip.file('META-INF/container.xml', buildContainerXml());
	const oebps = zip.folder('OEBPS')!;
	oebps.file('content.opf', buildOpf(opts.title, opts.author, bookId, modified));
	oebps.file('nav.xhtml', buildNav(opts.title));
	oebps.file('chapter1.xhtml', buildChapter(opts.title, htmlBody));
	oebps.file('style.css', CSS);

	return zip.generateAsync({
		type: 'arraybuffer',
		mimeType: 'application/epub+zip',
		compression: 'DEFLATE',
		compressionOptions: { level: 9 },
	});
}
