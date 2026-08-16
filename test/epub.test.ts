import { describe, expect, it } from 'bun:test';
import JSZip from 'jszip';
import { buildEpub } from '../src/epub/builder';
import { renderBodyHtml } from '../src/epub/render';
import type { ExtractedNote } from '../src/obsidian-extract/extract';

function note(bodyMarkdown: string): ExtractedNote {
	return { title: 'Note title', bodyMarkdown, embeds: [] };
}

async function chapterHtml(md: string): Promise<string> {
	const epub = await buildEpub(note(md), { title: 'Note title', author: 'Obsidian' });
	const zip = await JSZip.loadAsync(Buffer.from(epub));
	const chapter = zip.file('OEBPS/chapter1.xhtml');
	if (chapter === null) throw new Error('chapter1.xhtml missing from EPUB');
	return await chapter.async('string');
}

// Minimal well-formedness check for the generated XHTML: balanced element
// nesting, self-closing void elements, no stray '<' inside text nodes.
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^"'<>])*?)(\/?)>/g;
const VOID_ELEMENTS = new Set([
	'br',
	'hr',
	'img',
	'link',
	'meta',
	'input',
	'col',
	'area',
	'base',
	'embed',
	'source',
	'track',
	'wbr',
]);

function assertParsesAsXml(xml: string): void {
	const body = xml.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
	const stack: string[] = [];
	let lastIndex = 0;
	for (const match of body.matchAll(TAG_RE)) {
		const text = body.slice(lastIndex, match.index);
		lastIndex = match.index + match[0].length;
		expect(text, `stray '<' in text: ${JSON.stringify(text)}`).not.toContain('<');
		const tag = match[0];
		const name = match[1]!;
		const isClosing = tag.startsWith('</');
		const selfClosing = match[3] === '/' || tag.endsWith('/>');
		if (isClosing) {
			const open = stack.pop();
			expect(open, `mismatched </${name}>`).toBe(name);
		} else if (selfClosing || VOID_ELEMENTS.has(name)) {
			// Void or self-closing element: no pairing required.
		} else {
			stack.push(name);
		}
	}
	expect(stack, `unclosed elements: ${stack.join(', ')}`).toEqual([]);
}

describe('renderBodyHtml', () => {
	it('escapes raw script tags', () => {
		const html = renderBodyHtml('<script>alert(1)</script>');
		expect(html).toContain('&lt;script&gt;');
		expect(html).not.toContain('<script>');
	});

	it('escapes raw iframe tags', () => {
		const html = renderBodyHtml('<iframe src="https://evil.example"></iframe>');
		expect(html).toContain('&lt;iframe');
		expect(html).not.toContain('<iframe');
	});

	it('escapes embedded HTML blocks', () => {
		const html = renderBodyHtml('<div onclick="steal()">x</div>');
		expect(html).toContain('&lt;div');
		expect(html).not.toContain('<div');
	});

	it('escapes event handlers inside raw HTML', () => {
		const html = renderBodyHtml('<img src=x onerror=alert(1)>');
		expect(html).toContain('&lt;img');
		expect(html).not.toContain('<img');
	});

	it('preserves only the mark highlight tags produced by convertHighlights', () => {
		const html = renderBodyHtml('<mark>importante</mark> y <mark>más</mark>');
		expect(html).toContain('<mark>importante</mark>');
		expect(html).toContain('<mark>más</mark>');
	});

	it('escapes attacker-controlled mark attributes', () => {
		const html = renderBodyHtml('<mark onclick="x()">a</mark>');
		expect(html).not.toContain('<mark onclick');
	});

	it('renders markdown images as safe alt text without any img or src', () => {
		const html = renderBodyHtml('![alt text](https://evil.example/pixel.png)');
		expect(html).toContain('alt text');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('evil.example');
	});

	it('renders javascript: image URLs without executing or fetching', () => {
		const html = renderBodyHtml('![js](javascript:alert(1))');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('javascript:');
	});

	it('neutralizes javascript: links but keeps safe links', () => {
		const js = renderBodyHtml('[x](javascript:alert(1))');
		expect(js).not.toContain('href="javascript:');
		const safe = renderBodyHtml('[x](https://example.com)');
		expect(safe).toContain('href="https://example.com"');
	});

	it('emits self-closing line breaks and horizontal rules', () => {
		const html = renderBodyHtml('line one  \nline two\n\n---\n');
		expect(html).toContain('<br />');
		expect(html).not.toContain('<br>');
		expect(html).toContain('<hr />');
		expect(html).not.toContain('<hr>');
	});

	it('renders task lists as static checkbox symbols without <input> controls', () => {
		const html = renderBodyHtml('- [ ] pending\n- [x] done');
		expect(html).not.toContain('<input');
		expect(html).toContain('<span class="stk-task">[ ]</span>');
		expect(html).toContain('<span class="stk-task stk-task-checked">[x]</span>');
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	});

	it('escapes literal angle brackets in prose', () => {
		const html = renderBodyHtml('a < b & c > d');
		expect(html).toContain('&lt;');
		expect(html).toContain('&amp;');
	});

	it('is well-formed XML for a mixed document', () => {
		const html = renderBodyHtml(
			'# Título\n\nTexto con <mark>resaltado</mark>.\n\n- uno\n- dos\n\n`code` y **negrita**\n\n> cita\n',
		);
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	});
});

describe('buildEpub', () => {
	it('contains an escaped chapter with valid XHTML and no executable markup', async () => {
		const html = await chapterHtml(
			'<script>alert(1)</script>\n\n<iframe src="https://evil.example"></iframe>\n\n![remote](https://evil.example/x.png)\n\nline  \nbreak\n',
		);
		expect(html).not.toContain('<script>');
		expect(html).not.toContain('<iframe');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('src="https://evil.example');
		expect(html).toContain('&lt;script&gt;');
		expect(html).toContain('<br />');
		expect(html).not.toContain('<br>');
		assertParsesAsXml(html);
	});

	it('preserves mark highlights through the full EPUB build', async () => {
		const html = await chapterHtml('Esto es <mark>muy importante</mark>.');
		expect(html).toContain('<mark>muy importante</mark>');
		assertParsesAsXml(html);
	});

	it('keeps task list checkboxes out of the EPUB as controls but keeps the state', async () => {
		const html = await chapterHtml('- [ ] pendiente\n- [x] hecho');
		expect(html).not.toContain('<input');
		expect(html).toContain('[ ]');
		expect(html).toContain('[x]');
		assertParsesAsXml(html);
	});

	it('keeps remote images out of the EPUB but keeps their alt text', async () => {
		const html = await chapterHtml('![diagrama](https://evil.example/d.png)');
		expect(html).toContain('diagrama');
		expect(html).not.toContain('https://evil.example');
		assertParsesAsXml(html);
	});

	it('produces a valid EPUB zip structure', async () => {
		const epub = await buildEpub(note('Contenido normal'), { title: 'Mi nota', author: 'Yo' });
		const zip = await JSZip.loadAsync(Buffer.from(epub));
		for (const entry of [
			'mimetype',
			'META-INF/container.xml',
			'OEBPS/content.opf',
			'OEBPS/nav.xhtml',
			'OEBPS/chapter1.xhtml',
			'OEBPS/style.css',
		]) {
			expect(zip.file(entry), entry).not.toBeNull();
		}
		expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
	});
});
