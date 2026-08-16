/**
 * Shared XML 1.0 text sanitization.
 *
 * XML 1.0 (Fifth edition) forbids most C0 control characters, the two
 * noncharacters U+FFFE/U+FFFF, and the UTF-16 surrogate halves. This module
 * defines the exact set of valid code points and replaces every invalid
 * literal code point with U+FFFD, iterating by Unicode code point (not UTF-16
 * code unit) so valid astral characters are preserved and lone surrogates are
 * detected and replaced.
 */

export const XML_10_REPLACEMENT_CHAR = '\uFFFD';

// XML 1.0 Char production: #x9 | #xA | #xD | [#x20-#xD7FF] |
// [#xE000-#xFFFD] | [#x10000-#x10FFFF]. The surrogate range 0xD800-0xDFFF
// falls between the second and third ranges and is therefore invalid.
export function isXml10CodePoint(codePoint: number): boolean {
	return (
		codePoint === 0x9
		|| codePoint === 0xa
		|| codePoint === 0xd
		|| (codePoint >= 0x20 && codePoint <= 0xd7ff)
		|| (codePoint >= 0xe000 && codePoint <= 0xfffd)
		|| (codePoint >= 0x10000 && codePoint <= 0x10ffff)
	);
}

/**
 * Returns a copy of `value` with every literal code point that is not valid
 * in XML 1.0 replaced by U+FFFD. Valid astral characters (surrogate pairs)
 * are preserved intact; lone surrogates are replaced. Tabs, line feeds and
 * carriage returns are preserved.
 */
export function sanitizeXmlText(value: string): string {
	let result = '';
	let index = 0;
	while (index < value.length) {
		const first = value.charCodeAt(index);
		let codePoint = first;
		let width = 1;
		if (first >= 0xd800 && first <= 0xdbff) {
			const second = value.charCodeAt(index + 1);
			if (second >= 0xdc00 && second <= 0xdfff) {
				codePoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
				width = 2;
			}
			// A lone high surrogate keeps its own code unit value (invalid).
		} else if (first >= 0xdc00 && first <= 0xdfff) {
			// A lone low surrogate is likewise invalid.
		}
		if (isXml10CodePoint(codePoint)) {
			result += value.slice(index, index + width);
		} else {
			result += XML_10_REPLACEMENT_CHAR;
		}
		index += width;
	}
	return result;
}
