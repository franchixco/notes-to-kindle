import { Marked, Renderer } from 'marked';
import type {
	RendererThis,
	TokenizerAndRendererExtension,
	TokenizerThis,
	Tokens,
} from 'marked';
import { isXml10CodePoint, sanitizeXmlText } from './xml';

const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

// Anchored inline tokenizer for Obsidian `==highlight==`. Requires at least one
// non-whitespace character inside (no empty `====`), and the lazy body plus
// `\S` anchor gives first-close behavior: `==a==b==` highlights `a` only.
const HIGHLIGHT_INLINE_RE = /^==(?=\S)([\s\S]*?\S)==/;

// XML defines only the five predefined entities plus numeric character
// references. Marked preserves arbitrary named entities (and raw HTML) as-is,
// so unknown named entities such as &copy; are neutralized into their literal
// text form (&amp;copy;) by a final postprocess guard, while valid XML
// references are preserved.
const XML_PREDEFINED_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const ENTITY_REFERENCE_RE = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*)?;?/g;

function parseNumericRef(body: string): number | null {
	const rest = body.slice(1);
	if (rest.length === 0) return null;
	if (rest[0] === 'x' || rest[0] === 'X') {
		const hex = rest.slice(1);
		if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
		const value = parseInt(hex, 16);
		return Number.isFinite(value) ? value : null;
	}
	if (!/^[0-9]+$/.test(rest)) return null;
	const value = parseInt(rest, 10);
	return Number.isFinite(value) ? value : null;
}

// XML 1.0 Char production: #x9 | #xA | #xD | [#x20-#xD7FF] |
// [#xE000-#xFFFD] | [#x10000-#x10FFFF]. Shared with the builder via
// `isXml10CodePoint` in `./xml`; numeric character references are checked
// against the same definition so a reference and a literal never diverge.
function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function renderHtmlToken(token: Tokens.HTML | Tokens.Tag): string {
	// All raw HTML is escaped, including literal `<mark>` tags. Highlight
	// markup is only ever produced by the structural `==...==` extension.
	return escapeXml(token.text);
}

function renderAltText(this: Renderer, token: Tokens.Image): string {
	const alt = this.parser.parseInline(token.tokens, this.parser.textRenderer).trim();
	if (alt.length === 0) return '';
	return `<span class="stk-image">${escapeXml(alt)}</span>`;
}

function renderImage(this: Renderer, token: Tokens.Image, allowedImages: ReadonlySet<string>): string {
	if (!allowedImages.has(token.href)) return renderAltText.call(this, token);
	const alt = this.parser.parseInline(token.tokens, this.parser.textRenderer).trim();
	const titleAttr = token.title ? ` title="${escapeXml(token.title)}"` : '';
	return `<img class="stk-image" src="${escapeXml(token.href)}" alt="${escapeXml(alt)}"${titleAttr} />`;
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

// Official Marked v18 inline-extension pattern for `==highlight==`: `start`
// bounds the native text tokenizer so the anchored tokenizer runs first, and
// the inner markdown is tokenized structurally before being rendered inside
// the `<mark>` element.
const highlightExtension: TokenizerAndRendererExtension = {
	name: 'highlight',
	level: 'inline',
	start(this: TokenizerThis, src: string): number | void {
		const index = src.indexOf('==');
		return index === -1 ? undefined : index;
	},
	tokenizer(this: TokenizerThis, src: string): Tokens.Generic | undefined {
		const match = HIGHLIGHT_INLINE_RE.exec(src);
		if (match === null) return undefined;
		const inner = match[1] as string;
		return {
			type: 'highlight',
			raw: match[0],
			text: inner,
			tokens: this.lexer.inlineTokens(inner),
		};
	},
	renderer(this: RendererThis, token: Tokens.Generic): string | false | undefined {
		return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
	},
};

// marked only adopts the enumerable own properties of a renderer option, so
// the hardened renderers are assigned onto a base Renderer instance instead
// of subclassing it.
function createMarked(allowedImages: ReadonlySet<string>): Marked {
	const renderer = new Renderer();
	renderer.html = renderHtmlToken;
	renderer.br = (): string => '<br />';
	renderer.hr = (): string => '<hr />';
	renderer.image = function image(token: Tokens.Image): string {
		return renderImage.call(this, token, allowedImages);
	};
	renderer.checkbox = renderCheckbox;
	renderer.link = renderLink;
	return new Marked({
		gfm: true,
		breaks: false,
		renderer,
		extensions: [highlightExtension],
	});
}

/**
 * Final guard over the generated fragment: only the XML predefined entities
 * and decimal/hex numeric character references may pass through. Anything else
 * entity-shaped (unknown named entities such as `&copy;`, unterminated names,
 * bare ampersands) is turned into its literal safe text form.
 */
function guardXmlEntities(html: string): string {
	return html.replace(ENTITY_REFERENCE_RE, (match) => {
		const hasSemicolon = match.endsWith(';');
		const body = match.slice(1, hasSemicolon ? -1 : undefined);
		if (!hasSemicolon) {
			return `&amp;${match.slice(1)}`;
		}
		if (body.startsWith('#')) {
			const codePoint = parseNumericRef(body);
			if (codePoint !== null && isXml10CodePoint(codePoint)) return match;
			return `&amp;${body};`;
		}
		if (XML_PREDEFINED_ENTITIES.has(body)) return match;
		return `&amp;${body};`;
	});
}

export function renderBodyHtml(markdown: string, allowedImages: ReadonlySet<string> = new Set()): string {
	return sanitizeXmlText(guardXmlEntities(createMarked(allowedImages).parse(markdown, { async: false })));
}
