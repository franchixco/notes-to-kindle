import type crypto from 'crypto';

const nodeCrypto = window.require('crypto') as typeof crypto;

/**
 * Builds the `X-ADP-Request-Digest` value for an Amazon STK API request.
 *
 * Produces a PKCS#1 v1.5 RSA signature (SHA-256) over the newline-joined
 * string `METHOD\nPATH\nDATE\nBODY\nADP_TOKEN`, returned as
 * `{base64_signature}:{signingDate}`.
 */
export function signRequest(
	privateKeyPem: string,
	adpToken: string,
	method: string,
	path: string,
	signingDate: string,
	postData: string,
): string {
	const sigData = [method, path, signingDate, postData, adpToken].join('\n');

	const signer = nodeCrypto.createSign('RSA-SHA256');
	signer.update(sigData);
	signer.end();

	const signature = signer.sign(privateKeyPem, 'base64');
	return `${signature}:${signingDate}`;
}

export function isoUtcNow(): string {
	return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}
