import { describe, expect, it } from 'bun:test';
import { constants, createHash, generateKeyPairSync, privateEncrypt, publicDecrypt } from 'node:crypto';
import { signRequest } from '../src/stk/signer';

const SIGNATURE_FORMAT_RE = /^[A-Za-z0-9+/]+={0,2}:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function canonicalRequest(method: string, path: string, date: string, body: string, token: string): string {
	return [method, path, date, body, token].join('\n');
}

function makeKeyPair(): { publicKey: string; privateKey: string } {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	return { publicKey: publicKey.export({ type: 'pkcs1', format: 'pem' }) as string, privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string };
}

const INPUTS = {
	method: 'POST',
	path: '/GetUploadUrl',
	signingDate: '2026-08-15T12:34:56Z',
	postData: JSON.stringify({ ClientInfo: { appName: 'ShellExtension' }, fileSize: 1024 }, null, 4),
	adpToken: 'adp-token-for-tests',
};

describe('signRequest', () => {
	it('produces the base64 signature plus ISO timestamp format', () => {
		const { privateKey } = makeKeyPair();
		const signature = signRequest(
			privateKey,
			INPUTS.adpToken,
			INPUTS.method,
			INPUTS.path,
			INPUTS.signingDate,
			INPUTS.postData,
		);
		expect(signature).toMatch(SIGNATURE_FORMAT_RE);
		expect(signature.endsWith(INPUTS.signingDate)).toBe(true);
	});

	it('is deterministic for identical inputs', () => {
		const { privateKey } = makeKeyPair();
		const first = signRequest(
			privateKey,
			INPUTS.adpToken,
			INPUTS.method,
			INPUTS.path,
			INPUTS.signingDate,
			INPUTS.postData,
		);
		const second = signRequest(
			privateKey,
			INPUTS.adpToken,
			INPUTS.method,
			INPUTS.path,
			INPUTS.signingDate,
			INPUTS.postData,
		);
		expect(second).toBe(first);
	});

	it('changes the signature when any input changes', () => {
		const { privateKey } = makeKeyPair();
		const base = signRequest(
			privateKey,
			INPUTS.adpToken,
			INPUTS.method,
			INPUTS.path,
			INPUTS.signingDate,
			INPUTS.postData,
		);
		const other = signRequest(
			privateKey,
			INPUTS.adpToken,
			INPUTS.method,
			'/SendToKindle',
			INPUTS.signingDate,
			INPUTS.postData,
		);
		expect(other).not.toBe(base);
	});

	it('verifies against a Node crypto publicDecrypt oracle (RSA_NO_PADDING)', () => {
		const { publicKey, privateKey } = makeKeyPair();
		const signature = signRequest(
			privateKey,
			INPUTS.adpToken,
			INPUTS.method,
			INPUTS.path,
			INPUTS.signingDate,
			INPUTS.postData,
		);
		const sigPart = signature.slice(0, signature.lastIndexOf(':'));

		const digest = createHash('sha256')
			.update(
				canonicalRequest(
					INPUTS.method,
					INPUTS.path,
					INPUTS.signingDate,
					INPUTS.postData,
					INPUTS.adpToken,
				),
				'utf8',
			)
			.digest();

		const raw = publicDecrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, Buffer.from(sigPart, 'base64'));

		// Raw block is 256 bytes: 0x00 || 0x01 || 0xFF*221 || 0x00 || sha256(canonical).
		expect(raw.length).toBe(256);
		expect(raw[0]).toBe(0x00);
		expect(raw[1]).toBe(0x01);
		expect(raw.subarray(2, 223).every((byte) => byte === 0xff)).toBe(true);
		expect(raw[223]).toBe(0x00);
		expect(raw.subarray(224).equals(digest)).toBe(true);
	});

	it('matches a Node crypto privateEncrypt oracle byte-for-byte', () => {
		const { publicKey, privateKey } = makeKeyPair();
		const signature = signRequest(
			privateKey,
			INPUTS.adpToken,
			INPUTS.method,
			INPUTS.path,
			INPUTS.signingDate,
			INPUTS.postData,
		);
		const sigPart = signature.slice(0, signature.lastIndexOf(':'));

		// Recover the padded payload from the publicDecrypt oracle, then check
		// the plugin's signature equals a native RSA private encrypt of it.
		// RSA_NO_PADDING requires a full k-byte block, so pad the payload back
		// to the modulus size with a leading zero byte.
		const raw = publicDecrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, Buffer.from(sigPart, 'base64'));
		const payloadBlock = Buffer.concat([Buffer.alloc(1), raw.subarray(1)]);
		const expected = privateEncrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, payloadBlock);

		expect(Buffer.from(sigPart, 'base64').equals(expected)).toBe(true);
	});

	it('rejects non-RSA private keys', () => {
		const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
		const pem = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
		expect(() =>
			signRequest(pem, INPUTS.adpToken, INPUTS.method, INPUTS.path, INPUTS.signingDate, INPUTS.postData),
		).toThrow(/RSA private key parameters/);
	});
});
