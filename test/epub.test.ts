import { describe, expect, it } from 'bun:test';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync, type Unzipped } from 'fflate';
import { buildEpub } from '../src/epub/builder';
import { renderBodyHtml } from '../src/epub/render';
import { isXml10CodePoint } from '../src/epub/xml';
import type { ExtractedNote } from '../src/obsidian-extract/extract';

function note(bodyMarkdown: string): ExtractedNote {
	return { title: 'Note title', bodyMarkdown, embeds: [] };
}

async function chapterHtml(md: string): Promise<string> {
	const epub = await buildEpub(note(md), { title: 'Note title', author: 'Obsidian' });
	return strFromU8(requiredEntry(unzipSync(new Uint8Array(epub)), 'OEBPS/chapter1.xhtml'));
}

function requiredEntry(zip: Unzipped, path: string): Uint8Array {
	const entry = zip[path];
	if (entry === undefined) throw new Error(`${path} missing from EPUB`);
	return entry;
}

// Real XML well-formedness check through @xmldom/xmldom: any warning, error or
// fatalError reported by the parser (or a thrown ParseError) fails the test.
function assertParsesAsXml(xml: string): void {
	const problems: string[] = [];
	try {
		new DOMParser({
			onError: (level, message) => {
				if (level === 'warning' || level === 'error' || level === 'fatalError') {
					// xmldom warns on any U+FFFD as a source-encoding heuristic,
					// but U+FFFD is valid XML 1.0 and is exactly what our
					// sanitizer emits, so that one known-benign warning is
					// ignored; every other warning/error still fails.
					if (level === 'warning' && message.includes('replacement character')) return;
					problems.push(`${level}: ${message}`);
				}
			},
		}).parseFromString(xml, 'application/xml');
	} catch (error) {
		problems.push(String(error));
	}
	expect(problems, xml).toEqual([]);
}

// Code-point scan for literal characters that XML 1.0 forbids, independent of
// any parser leniency: astral pairs iterate as one code point and lone
// surrogates surface as invalid code units.
function assertNoForbiddenCodePoints(xml: string): void {
	for (const ch of xml) {
		const codePoint = ch.codePointAt(0) ?? -1;
		expect(isXml10CodePoint(codePoint), `forbidden U+${codePoint.toString(16)} in XML`).toBe(
			true,
		);
	}
}

// Literal code points that XML 1.0 forbids, exercised through the full EPUB
// build. Lone surrogates are covered separately because joining them could
// accidentally form a valid astral pair.
const FORBIDDEN_LITERALS = ['\u0000', '\u0001', '\u0008', '\u000B', '\u000C', '\uFFFE', '\uFFFF'];

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

	it('escapes literal mark tags instead of treating them as highlight markup', () => {
		const html = renderBodyHtml('<mark>importante</mark> y <mark>más</mark>');
		expect(html).toContain('&lt;mark&gt;importante&lt;/mark&gt;');
		expect(html).not.toContain('<mark>importante</mark>');
	});

	it('does not allow independent literal open/close mark tags', () => {
		const html = renderBodyHtml('abierto <mark> y cerrado </mark>');
		expect(html).toContain('&lt;mark&gt;');
		expect(html).toContain('&lt;/mark&gt;');
		expect(html).not.toMatch(/<mark>(?!<\/mark>)/);
	});

	it('escapes attacker-controlled mark attributes', () => {
		const html = renderBodyHtml('<mark onclick="x()">a</mark>');
		expect(html).not.toContain('<mark onclick');
		expect(html).toContain('&lt;mark onclick=');
	});

	it('renders Obsidian ==highlights== as structural mark elements', () => {
		const html = renderBodyHtml('==importante== y ==más==');
		expect(html).toContain('<mark>importante</mark>');
		expect(html).toContain('<mark>más</mark>');
	});

	it('renders nested markdown inside a highlight', () => {
		const html = renderBodyHtml('==**negrita** y `codigo`==');
		expect(html).toContain('<mark><strong>negrita</strong> y <code>codigo</code></mark>');
	});

	it('escapes raw markup nested inside a highlight', () => {
		const html = renderBodyHtml('==<mark>x</mark>==');
		expect(html).toContain('<mark>&lt;mark&gt;x&lt;/mark&gt;</mark>');
		expect(html).not.toContain('<mark><mark>');
	});

	it('closes a highlight at the first closing delimiter', () => {
		const html = renderBodyHtml('==a==b==');
		expect(html).toContain('<mark>a</mark>b==');
	});

	it('leaves unmatched open highlight delimiters as literal text', () => {
		const html = renderBodyHtml('==abierto');
		expect(html).toContain('==abierto');
		expect(html).not.toContain('<mark>');
	});

	it('leaves a closing-only highlight delimiter as literal text', () => {
		const html = renderBodyHtml('cerrado==');
		expect(html).toContain('cerrado==');
		expect(html).not.toContain('<mark>');
	});

	it('keeps text without highlight delimiters intact', () => {
		const html = renderBodyHtml('sin delimitadores de resaltado en absoluto');
		expect(html).not.toContain('<mark>');
		expect(html).toContain('sin delimitadores de resaltado en absoluto');
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	});

	it('neutralizes XML-invalid numeric character references', () => {
		const html = renderBodyHtml(
			'&#0; &#x0; &#X0; &#x8; &#x1F; &#xD800; &#xDFFF; &#xFFFE; &#xFFFF; &#x110000; &#x7FFFFFFF;',
		);
		for (const literal of ['#0;', '#x0;', '#X0;', '#x8;', '#x1F;', '#xD800;', '#xDFFF;', '#xFFFE;', '#xFFFF;', '#x110000;', '#x7FFFFFFF;']) {
			expect(html, literal).toContain(`&amp;${literal}`);
		}
		expect(html).not.toContain('&#0;');
		expect(html).not.toContain('&#xD800;');
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	});

	it('preserves valid XML 1.0 numeric character references at the boundaries', () => {
		const html = renderBodyHtml(
			'&#9; &#10; &#13; &#x20; &#xD7FF; &#xE000; &#xFFFD; &#x10000; &#x10FFFF;',
		);
		for (const ref of ['&#9;', '&#10;', '&#13;', '&#x20;', '&#xD7FF;', '&#xE000;', '&#xFFFD;', '&#x10000;', '&#x10FFFF;']) {
			expect(html, ref).toContain(ref);
		}
		expect(html).not.toContain('&amp;#9;');
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	});

	it('turns unknown named entities into literal safe text', () => {
		const html = renderBodyHtml('&copy; 2026 y &nbsp;');
		expect(html).toContain('&amp;copy;');
		expect(html).toContain('&amp;nbsp;');
		expect(html).not.toContain('&copy;');
		expect(html).not.toContain('&nbsp;');
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	});

	it('preserves valid XML entities and numeric character references', () => {
		const html = renderBodyHtml('&amp; &lt; &gt; &quot; &apos; &#169; &#x00A9;');
		expect(html).toContain('&amp;');
		expect(html).toContain('&lt;');
		expect(html).toContain('&gt;');
		expect(html).toContain('&quot;');
		expect(html).toContain('&apos;');
		expect(html).toContain('&#169;');
		expect(html).toContain('&#x00A9;');
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
	});

	it('neutralizes malformed ampersands', () => {
		const html = renderBodyHtml('AT&T y &copy sin punto y coma y &&');
		expect(html).toContain('AT&amp;T');
		expect(html).toContain('&amp;copy');
		expect(html).toContain('&amp;&amp;');
		assertParsesAsXml(`<html xmlns="http://www.w3.org/1999/xhtml"><body>${html}</body></html>`);
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
			'# Título\n\nTexto con ==resaltado==.\n\n- uno\n- dos\n\n`code` y **negrita**\n\n> cita\n',
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

	it('preserves Obsidian highlights through the full EPUB build', async () => {
		const html = await chapterHtml('Esto es ==muy importante==.');
		expect(html).toContain('<mark>muy importante</mark>');
		assertParsesAsXml(html);
	});

	it('escapes literal mark tags in the full chapter while keeping highlights', async () => {
		const html = await chapterHtml('<mark>literal</mark> y ==resaltado==');
		expect(html).toContain('&lt;mark&gt;literal&lt;/mark&gt;');
		expect(html).toContain('<mark>resaltado</mark>');
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

	it('produces a fully parseable chapter for adversarial content', async () => {
		const html = await chapterHtml(
			'<script>alert(1)</script>\n\n==<b onmouseover="x()">hl</b>== &copy; &bogus; AT&T\n\n<div onclick="y()">z</div> ==a==b==\n\n---\n\n- [x] listo\n\n![alt](javascript:void(0))\n\n<mark>literal</mark> y ==resaltado==\n',
		);
		assertParsesAsXml(html);
		expect(html).not.toContain('<script');
		expect(html).toContain('<mark>&lt;b onmouseover=&quot;x()&quot;&gt;hl&lt;/b&gt;</mark>');
	});

	it('neutralizes invalid numeric references through the full chapter', async () => {
		const html = await chapterHtml('&#0; &#xD800; &#x110000; y validos &#9; &#x10FFFF;');
		expect(html).toContain('&amp;#0;');
		expect(html).toContain('&amp;#xD800;');
		expect(html).toContain('&amp;#x110000;');
		expect(html).toContain('&#9;');
		expect(html).toContain('&#x10FFFF;');
		assertParsesAsXml(html);
	});

	it('replaces literal XML 1.0-invalid code points in the body with U+FFFD', async () => {
		const body = `before${FORBIDDEN_LITERALS.join('')}after`;
		const html = await chapterHtml(body);
		for (const bad of FORBIDDEN_LITERALS) {
			expect(html, JSON.stringify(bad)).not.toContain(bad);
		}
		expect(html).toContain('before');
		expect(html).toContain('after');
		expect(html.match(/\uFFFD/g)?.length ?? 0).toBe(FORBIDDEN_LITERALS.length);
		assertNoForbiddenCodePoints(html);
		assertParsesAsXml(html);
	});

	it('replaces lone surrogates in the body with U+FFFD while keeping paired astral characters', async () => {
		const html = await chapterHtml('a\uD800b\uDC00c\uD83D\uDE00d');
		expect(html).toContain('c\u{1F600}d');
		// The two lone surrogates must each become one U+FFFD; the emoji pair
		// stays intact and must not be counted as replacements.
		expect(html.match(/\uFFFD/g)?.length ?? 0).toBe(2);
		assertNoForbiddenCodePoints(html);
		assertParsesAsXml(html);
	});

	it('sanitizes literal XML 1.0-invalid code points in the title and author', async () => {
		const title = `Ti\u0001tle\uFFFE`;
		const author = `Au\uD800thor\uFFFF`;
		const epub = await buildEpub(note('Contenido'), { title, author });
		const zip = unzipSync(new Uint8Array(epub));
		const opf = strFromU8(requiredEntry(zip, 'OEBPS/content.opf'));
		const nav = strFromU8(requiredEntry(zip, 'OEBPS/nav.xhtml'));
		const chapter = strFromU8(requiredEntry(zip, 'OEBPS/chapter1.xhtml'));

		for (const xml of [opf, nav, chapter]) {
			assertNoForbiddenCodePoints(xml);
			assertParsesAsXml(xml);
		}
		expect(opf).toContain('\uFFFD');
		expect(nav).toContain('\uFFFD');
		expect(chapter).toContain('\uFFFD');
		expect(opf).not.toContain('\u0001');
		expect(opf).not.toContain('\uFFFE');
		expect(opf).not.toContain('\uFFFF');
		expect(chapter).not.toContain('\u0001');
		expect(chapter).not.toContain('\uFFFE');
	});

	it('preserves tab, LF, U+FFFD and astral code points through the body', async () => {
		const html = await chapterHtml('tab\there  \uFFFD  \u{10000}  \u{1F600} final');
		expect(html).toContain('tab\there');
		expect(html).toContain('\uFFFD');
		expect(html).toContain('\u{10000}');
		expect(html).toContain('\u{1F600}');
		expect(html).toContain('final');
		assertNoForbiddenCodePoints(html);
		assertParsesAsXml(html);
	});

	it('produces clean OPF, nav and chapter metadata for valid astral titles', async () => {
		const epub = await buildEpub(note('Contenido'), {
			title: 'Nota \u{1F4D6} \u{10000}',
			author: 'Autor',
		});
		const zip = unzipSync(new Uint8Array(epub));
		const opf = strFromU8(requiredEntry(zip, 'OEBPS/content.opf'));
		const nav = strFromU8(requiredEntry(zip, 'OEBPS/nav.xhtml'));
		expect(opf).toContain('Nota \u{1F4D6} \u{10000}');
		expect(nav).toContain('Nota \u{1F4D6} \u{10000}');
		assertNoForbiddenCodePoints(opf);
		assertNoForbiddenCodePoints(nav);
		assertParsesAsXml(opf);
		assertParsesAsXml(nav);
	});

	it('produces a valid EPUB zip structure', async () => {
		const epub = await buildEpub(note('Contenido normal'), { title: 'Mi nota', author: 'Yo' });
		const zip = unzipSync(new Uint8Array(epub));
		for (const entry of [
			'mimetype',
			'META-INF/container.xml',
			'OEBPS/content.opf',
			'OEBPS/nav.xhtml',
			'OEBPS/chapter1.xhtml',
			'OEBPS/style.css',
		]) {
			expect(zip[entry], entry).toBeDefined();
		}
		expect(strFromU8(requiredEntry(zip, 'mimetype'))).toBe('application/epub+zip');
	});

	it('stores mimetype uncompressed as the first local file entry', async () => {
		const epub = await buildEpub(note('Contenido normal'), { title: 'Mi nota', author: 'Yo' });
		const view = new DataView(epub);
		expect(view.getUint32(0, true)).toBe(0x04034b50);
		expect(view.getUint16(8, true)).toBe(0);
		const nameLength = view.getUint16(26, true);
		const name = strFromU8(new Uint8Array(epub, 30, nameLength));
		expect(name).toBe('mimetype');
	});
});
