import type crypto from 'crypto';

const nodeCrypto = window.require('crypto') as typeof crypto;

export interface PkcePair {
	verifier: string;
	challenge: string;
}

export interface OAuthResult {
	authorizationCode: string;
}

function base64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function generatePkce(): Promise<PkcePair> {
	const verifier = base64url(nodeCrypto.randomBytes(32));
	const challenge = base64url(nodeCrypto.createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}
