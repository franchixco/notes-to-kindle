import type crypto from 'crypto';

const nodeCrypto = window.require('crypto') as typeof crypto;

export function signRequest(
	privateKeyPem: string,
	adpToken: string,
	method: string,
	path: string,
	signingDate: string,
	postData: string,
): string {
	throw new Error('not implemented');
}

export function isoUtcNow(): string {
	return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}
