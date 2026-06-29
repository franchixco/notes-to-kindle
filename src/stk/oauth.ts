import type http from 'http';

const nodeHttp = window.require('http') as typeof http;

export interface PkcePair {
	verifier: string;
	challenge: string;
}

export interface OAuthResult {
	authorizationCode: string;
}

export async function generatePkce(): Promise<PkcePair> {
	throw new Error('not implemented');
}

export async function runOAuthFlow(
	authUrlBuilder: (pkce: PkcePair, redirectUri: string) => string,
): Promise<OAuthResult> {
	void nodeHttp;
	throw new Error('not implemented');
}
