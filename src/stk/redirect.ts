/**
 * Strict parsing of the Amazon Send to Kindle OAuth redirect.
 *
 * The authorization window is only ever allowed to complete against the exact
 * return URL we configured for the flow. Anything else — a lookalike host, a
 * wrong scheme, an embedded credential in the URL, an explicit error response,
 * or a code that never arrived — must fail fast instead of silently continuing.
 */

const REDIRECT_SCHEME = 'https:';
const REDIRECT_HOST = 'www.amazon.com';
const REDIRECT_PATHNAME = '/gp/sendtokindle';

// The only hosts the OAuth window may ever navigate to at the top level.
const ALLOWED_NAVIGATION_HOSTS = new Set(['www.amazon.com', 'amazon.com']);

export class InvalidRedirectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidRedirectError';
	}
}

export class OAuthDeniedError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(`Authentication denied by Amazon: ${reason}`);
		this.name = 'OAuthDeniedError';
		this.reason = reason;
	}
}

function parseStrict(urlText: string): URL | null {
	try {
		return new URL(urlText);
	} catch {
		return null;
	}
}

/**
 * True only for the exact Send to Kindle redirect target:
 * `https://www.amazon.com/gp/sendtokindle` (any query string), with no
 * userinfo and a default port. Used to decide whether a navigation should be
 * treated as the end of the OAuth flow at all.
 */
export function isRedirectUrl(raw: string): boolean {
	if (typeof raw !== 'string' || raw.length === 0) return false;
	const url = parseStrict(raw);
	if (!url) return false;
	return (
		url.protocol === REDIRECT_SCHEME
		&& url.hostname === REDIRECT_HOST
		&& url.pathname === REDIRECT_PATHNAME
		&& url.port === ''
		&& url.username === ''
		&& url.password === ''
	);
}

/**
 * True only for HTTPS top-level navigations in the OAuth window that stay on
 * the exact Amazon login hosts (`www.amazon.com` / `amazon.com`) with a
 * default port and no userinfo. Anything else — external hosts, lookalike or
 * suffix hosts, non-HTTPS schemes — must be rejected by the `will-navigate`
 * handler. This is a navigation gate, not the redirect completion check; the
 * final redirect is still validated by {@link isRedirectUrl} and
 * {@link parseAuthorizationCode}.
 */
export function isAllowedOAuthNavigation(raw: string): boolean {
	if (typeof raw !== 'string' || raw.length === 0) return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	return (
		url.protocol === REDIRECT_SCHEME
		&& url.port === ''
		&& url.username === ''
		&& url.password === ''
		&& ALLOWED_NAVIGATION_HOSTS.has(url.hostname)
	);
}

/**
 * Extracts and validates the OAuth authorization code from the redirect URL.
 *
 * Throws {@link InvalidRedirectError} when the URL is not the expected Amazon
 * redirect (malformed, wrong scheme/host/path, non-default port, userinfo,
 * missing or empty code, code only present in the fragment) and
 * {@link OAuthDeniedError} when Amazon reports that the request was denied.
 */
export function parseAuthorizationCode(redirectUrl: string): string {
	const url = parseStrict(redirectUrl);
	if (!url) {
		throw new InvalidRedirectError('Redirect URL is malformed');
	}
	if (
		url.protocol !== REDIRECT_SCHEME
		|| url.hostname !== REDIRECT_HOST
		|| url.pathname !== REDIRECT_PATHNAME
	) {
		throw new InvalidRedirectError('Not the Amazon Send to Kindle redirect');
	}
	if (url.port !== '') {
		throw new InvalidRedirectError('Redirect URL must use the default HTTPS port');
	}
	if (url.username !== '' || url.password !== '') {
		throw new InvalidRedirectError('Redirect URL must not contain userinfo');
	}

	const errorParam = url.searchParams.get('error') ?? url.searchParams.get('openid.error');
	const openIdMode = url.searchParams.get('openid.mode');
	if (openIdMode === 'error' || errorParam !== null) {
		throw new OAuthDeniedError(errorParam ?? 'the authorization request was denied');
	}

	const code = url.searchParams.get('openid.oa2.authorization_code');
	if (code === null || code.length === 0) {
		throw new InvalidRedirectError('Redirect URL does not carry an authorization code');
	}
	return code;
}
