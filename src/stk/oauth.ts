import type http from 'http';

const nodeHttp = window.require('http') as typeof http;
const nodeCrypto = window.require('crypto') as typeof import('crypto');

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

export async function runOAuthFlow(
	authUrlBuilder: (pkce: PkcePair, redirectUri: string) => string,
): Promise<OAuthResult> {
	const pkce = await generatePkce();

	return new Promise<OAuthResult>((resolve, reject) => {
		let settled = false;
		let port = 0;
		let timer: number | undefined;

		const cleanup = (): void => {
			if (timer !== undefined) window.clearTimeout(timer);
			server.close();
		};

		const resolveOnce = (result: OAuthResult): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		const rejectOnce = (err: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const server = nodeHttp.createServer((req, res) => {
			const reqUrl = req.url ?? '';
			if (!reqUrl.startsWith('/callback')) {
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('Not found');
				return;
			}

			const url = new URL(reqUrl, `http://127.0.0.1:${port}`);
			const code =
				url.searchParams.get('openid.oa2.authorization_code') ??
				url.searchParams.get('code');

			if (!code) {
				const err = url.searchParams.get('error');
				res.writeHead(400, { 'Content-Type': 'text/html' });
				res.end(
					'<html><body><h1>Authentication failed</h1><p>You can close this tab and return to Obsidian.</p></body></html>',
				);
				rejectOnce(
					err
						? new Error(`OAuth provider returned error: ${err}`)
						: new Error('OAuth callback missing authorization code'),
				);
				return;
			}

			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end(
				'<html><body><h1>Authentication successful</h1><p>You can close this tab and return to Obsidian.</p></body></html>',
			);
			resolveOnce({ authorizationCode: code });
		});

		server.on('error', (err: Error) => {
			rejectOnce(err);
		});

		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				rejectOnce(new Error('Failed to bind local OAuth server'));
				return;
			}
			port = address.port;
			const redirectUri = `http://127.0.0.1:${port}/callback`;
			const authUrl = authUrlBuilder(pkce, redirectUri);
			window.open(authUrl);
		});

		timer = window.setTimeout(() => {
			rejectOnce(new Error('OAuth flow timed out after 5 minutes'));
		}, 5 * 60 * 1000);
	});
}
