import { Marked, Renderer } from 'marked';
import type { Tokens } from 'marked';

const MARK_TAG_OPEN = '<mark>';
const MARK_TAG_CLOSE = '</mark>';
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function renderHtmlToken(token: Tokens.HTML | Tokens.Tag): string {
	if (token.text === MARK_TAG_OPEN || token.text === MARK_TAG_CLOSE) return token.text;
	return escapeXml(token.text);
}

function renderAltText(this: Renderer, token: Tokens.Image): string {
	const alt = this.parser.parseInline(token.tokens, this.parser.textRenderer).trim();
	if (alt.length === 0) return '';
	return `<span class="stk-image">${escapeXml(alt)}</span>`;
}

function isSafeLinkHref(href: string): boolean {
	const trimmed = href.trim();
	if (trimmed.length === 0 || trimmed.startsWith('#')) return true;
	try {
		return SAFE_LINK_SCHEMES.has(new URL(trimmed).protocol);
	} catch {
		return false;
	}
}

function renderCheckbox(token: Tokens.Checkbox): string {
	return token.checked
		? '<span class="stk-task stk-task-checked">[x]</span>'
		: '<span class="stk-task">[ ]</span>';
}

function renderLink(this: Renderer, token: Tokens.Link): string {
	const inner = this.parser.parseInline(token.tokens);
	if (!isSafeLinkHref(token.href)) {
		return inner;
	}
	const titleAttr = token.title ? ` title="${escapeXml(token.title)}"` : '';
	return `<a href="${escapeXml(token.href)}"${titleAttr}>${inner}</a>`;
}

// marked only adopts the enumerable own properties of a renderer option, so
// the hardened renderers are assigned onto a base Renderer instance instead
// of subclassing it.
const renderer = new Renderer();
renderer.html = renderHtmlToken;
renderer.br = (): string => '<br />';
renderer.hr = (): string => '<hr />';
renderer.image = renderAltText;
renderer.checkbox = renderCheckbox;
renderer.link = renderLink;

const stkMarked = new Marked({
	gfm: true,
	breaks: false,
	renderer,
});

export function renderBodyHtml(markdown: string): string {
	return stkMarked.parse(markdown, { async: false });
}
