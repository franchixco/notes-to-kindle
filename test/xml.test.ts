import { describe, expect, it } from 'bun:test';
import { isXml10CodePoint, sanitizeXmlText } from '../src/epub/xml';

describe('sanitizeXmlText', () => {
	it('replaces every XML 1.0-invalid literal code point with U+FFFD', () => {
		const forbidden = [
			'\u0000',
			'\u0001',
			'\u0008',
			'\u000B',
			'\u000C',
			'\u000E',
			'\u001F',
			'\uFFFE',
			'\uFFFF',
			'\uD800',
			'\uDC00',
			'\uDBFF',
			'\uDFFF',
		];
		for (const bad of forbidden) {
			expect(sanitizeXmlText(`a${bad}b`), JSON.stringify(bad)).toBe(`a\uFFFDb`);
		}
	});

	it('preserves tab, LF, CR, U+FFFD and valid astral code points', () => {
		const input = '\t\n\r \uFFFD \u{10000} \u{1F600} \u00E9 \u20AC \uD7FF \uE000';
		expect(sanitizeXmlText(input)).toBe(input);
	});

	it('keeps a valid astral character intact as one code point', () => {
		const input = 'a\u{1F600}b\u{10000}c\u{10FFFF}d';
		expect(sanitizeXmlText(input)).toBe(input);
		expect([...sanitizeXmlText('\u{1F600}')]).toEqual(['\u{1F600}']);
	});

	it('replaces lone surrogates but keeps paired astral characters', () => {
		const input = 'x\uD83D\uDE00y\uD800z\uDE00w';
		expect(sanitizeXmlText(input)).toBe('x\u{1F600}y\uFFFDz\uFFFDw');
	});

	it('returns the empty string for empty input', () => {
		expect(sanitizeXmlText('')).toBe('');
	});
});

describe('isXml10CodePoint', () => {
	it('accepts every range of the XML 1.0 Char production', () => {
		for (const codePoint of [0x9, 0xa, 0xd, 0x20, 0xd7ff, 0xe000, 0xfffd, 0x10000, 0x10ffff]) {
			expect(isXml10CodePoint(codePoint), `U+${codePoint.toString(16)}`).toBe(true);
		}
	});

	it('rejects controls, surrogates, noncharacters and out-of-range values', () => {
		const rejected = [0x0, 0x1, 0x8, 0xb, 0xc, 0xe, 0x1f, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffe, 0xffff, 0x110000, 0x7fffffff];
		for (const codePoint of rejected) {
			expect(isXml10CodePoint(codePoint), `U+${codePoint.toString(16)}`).toBe(false);
		}
	});
});
