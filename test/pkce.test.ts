import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { generatePkce } from '../src/stk/oauth';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function base64url(buf: Buffer): string {
	return buf
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

describe('generatePkce', () => {
	it('produces a verifier and challenge of the expected shape', async () => {
		const { verifier, challenge } = await generatePkce();
		expect(verifier).toMatch(BASE64URL_RE);
		expect(challenge).toMatch(BASE64URL_RE);
		expect(verifier.length).toBe(43);
		expect(challenge.length).toBe(43);
	});

	it('derives the challenge as S256 of the verifier', async () => {
		const { verifier, challenge } = await generatePkce();
		const expected = base64url(createHash('sha256').update(verifier).digest());
		expect(challenge).toBe(expected);
	});

	it('does not leak the verifier into the challenge', async () => {
		const { verifier, challenge } = await generatePkce();
		expect(challenge).not.toBe(verifier);
	});

	it('generates unique pairs across calls', async () => {
		const [first, second] = await Promise.all([generatePkce(), generatePkce()]);
		expect(first.verifier).not.toBe(second.verifier);
		expect(first.challenge).not.toBe(second.challenge);
	});
});
