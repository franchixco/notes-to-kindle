import { describe, expect, it } from 'bun:test';
import {
	InvalidRedirectError,
	isAllowedOAuthNavigation,
	isRedirectUrl,
	OAuthDeniedError,
	parseAuthorizationCode,
} from '../src/stk/redirect';

const VALID_CODE = 'Atza|IwEBIPVaLQVF3cOWpBXDcTOkT4ivRYPGAvHXKBKLnFFYmqhJ7';
const VALID_REDIRECT = `https://www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=${VALID_CODE}`;

describe('parseAuthorizationCode', () => {
	it('extracts the code from a valid redirect', () => {
		expect(parseAuthorizationCode(VALID_REDIRECT)).toBe(VALID_CODE);
	});

	it('accepts extra unrelated query parameters', () => {
		const url = `${VALID_REDIRECT}&openid.assoc_handle=amzn_device_na&pageId=amzn_device_common_dark`;
		expect(parseAuthorizationCode(url)).toBe(VALID_CODE);
	});

	it('normalizes an uppercase host to the allowed host', () => {
		const url = `https://WWW.AMAZON.COM/gp/sendtokindle?openid.oa2.authorization_code=${VALID_CODE}`;
		expect(parseAuthorizationCode(url)).toBe(VALID_CODE);
	});

	it('throws InvalidRedirectError on malformed URLs', () => {
		for (const bad of ['', 'not a url', 'https://', 'http://', 'www.amazon.com/gp/sendtokindle']) {
			expect(() => parseAuthorizationCode(bad)).toThrow(InvalidRedirectError);
		}
	});

	it('rejects a non-HTTPS scheme', () => {
		const url = `http://www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=${VALID_CODE}`;
		expect(() => parseAuthorizationCode(url)).toThrow(InvalidRedirectError);
	});

	it('rejects wrong hosts and deceptive suffixes', () => {
		const hosts = [
			'amazon.com',
			'auth.amazon.com',
			'www.amazon.com.evil.com',
			'www.amazon.co.uk',
			'www-amazon.com',
			'evilamazon.com',
			'www.amazonaws.com',
		];
		for (const host of hosts) {
			const url = `https://${host}/gp/sendtokindle?openid.oa2.authorization_code=${VALID_CODE}`;
			expect(() => parseAuthorizationCode(url), `host ${host}`).toThrow(InvalidRedirectError);
		}
	});

	it('rejects wrong paths', () => {
		const paths = ['/gp/sendtokindle/', '/sendtokindle', '/gp/other', '/gp/sendtokindle/extra'];
		for (const path of paths) {
			const url = `https://www.amazon.com${path}?openid.oa2.authorization_code=${VALID_CODE}`;
			expect(() => parseAuthorizationCode(url), `path ${path}`).toThrow(InvalidRedirectError);
		}
	});

	it('rejects a non-default port', () => {
		const url = `https://www.amazon.com:8443/gp/sendtokindle?openid.oa2.authorization_code=${VALID_CODE}`;
		expect(() => parseAuthorizationCode(url)).toThrow(InvalidRedirectError);
	});

	it('rejects userinfo', () => {
		const url = `https://attacker:secret@www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=${VALID_CODE}`;
		expect(() => parseAuthorizationCode(url)).toThrow(InvalidRedirectError);
	});

	it('rejects a missing authorization code', () => {
		expect(() => parseAuthorizationCode('https://www.amazon.com/gp/sendtokindle')).toThrow(
			InvalidRedirectError,
		);
	});

	it('rejects an empty authorization code', () => {
		const url = 'https://www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=';
		expect(() => parseAuthorizationCode(url)).toThrow(InvalidRedirectError);
	});

	it('rejects a fragment-only code', () => {
		const url = `https://www.amazon.com/gp/sendtokindle#openid.oa2.authorization_code=${VALID_CODE}`;
		expect(() => parseAuthorizationCode(url)).toThrow(InvalidRedirectError);
	});

	it('rejects protocol-relative URLs', () => {
		const url = `//www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=${VALID_CODE}`;
		expect(() => parseAuthorizationCode(url)).toThrow(InvalidRedirectError);
	});

	it('fails fast with OAuthDeniedError when Amazon reports a denial', () => {
		expect(() =>
			parseAuthorizationCode('https://www.amazon.com/gp/sendtokindle?error=access_denied'),
		).toThrow(OAuthDeniedError);
		expect(() =>
			parseAuthorizationCode('https://www.amazon.com/gp/sendtokindle?openid.error=user_denied'),
		).toThrow(OAuthDeniedError);
		expect(() =>
			parseAuthorizationCode('https://www.amazon.com/gp/sendtokindle?openid.mode=error'),
		).toThrow(OAuthDeniedError);
	});

	it('keeps the denial reason on the error', () => {
		try {
			parseAuthorizationCode('https://www.amazon.com/gp/sendtokindle?error=access_denied');
		} catch (err) {
			expect(err).toBeInstanceOf(OAuthDeniedError);
			expect((err as OAuthDeniedError).reason).toBe('access_denied');
			return;
		}
		throw new Error('expected OAuthDeniedError');
	});
});

describe('isRedirectUrl', () => {
	it('matches the exact redirect target with a query string', () => {
		expect(isRedirectUrl(VALID_REDIRECT)).toBe(true);
		expect(isRedirectUrl('https://www.amazon.com/gp/sendtokindle')).toBe(true);
	});

	it('does not match lookalikes, wrong schemes or malformed input', () => {
		expect(isRedirectUrl('https://amazon.com/gp/sendtokindle')).toBe(false);
		expect(isRedirectUrl('https://www.amazon.com.evil.com/gp/sendtokindle')).toBe(false);
		expect(isRedirectUrl('http://www.amazon.com/gp/sendtokindle')).toBe(false);
		expect(isRedirectUrl('https://www.amazon.com/other')).toBe(false);
		expect(isRedirectUrl('https://www.amazon.com/gp/sendtokindle/')).toBe(false);
		expect(isRedirectUrl('https://www.amazon.com:8080/gp/sendtokindle')).toBe(false);
		expect(isRedirectUrl('https://user@www.amazon.com/gp/sendtokindle')).toBe(false);
		expect(isRedirectUrl('not a url')).toBe(false);
		expect(isRedirectUrl('')).toBe(false);
	});
});

describe('isAllowedOAuthNavigation', () => {
	it('allows HTTPS on the exact Amazon login hosts', () => {
		expect(isAllowedOAuthNavigation('https://www.amazon.com/ap/signin?openid.mode=checkid_setup')).toBe(true);
		expect(isAllowedOAuthNavigation('https://amazon.com/ap/signin')).toBe(true);
	});

	it('does not classify the final Send to Kindle redirect as external', () => {
		expect(isAllowedOAuthNavigation(VALID_REDIRECT)).toBe(true);
		expect(isAllowedOAuthNavigation('https://www.amazon.com/gp/sendtokindle')).toBe(true);
		expect(isAllowedOAuthNavigation('https://amazon.com/gp/sendtokindle?openid.oa2.authorization_code=x')).toBe(true);
	});

	it('rejects non-HTTPS, lookalike and external hosts', () => {
		const blocked = [
			'http://www.amazon.com/ap/signin',
			'ftp://www.amazon.com/ap/signin',
			'https://amazon.com.evil.com/ap/signin',
			'https://www.amazon.com.evil.com/gp/sendtokindle?openid.oa2.authorization_code=x',
			'https://evilamazon.com/ap/signin',
			'https://www.amazon.co.uk/ap/signin',
			'https://www.amazonaws.com/ap/signin',
			'https://www-amazon.com/ap/signin',
			'https://www.google.com/',
			'https://evil.com/?next=https://www.amazon.com/gp/sendtokindle',
			'not a url',
			'',
		];
		for (const url of blocked) {
			expect(isAllowedOAuthNavigation(url), url).toBe(false);
		}
	});

	it('rejects a non-default port or userinfo', () => {
		expect(isAllowedOAuthNavigation('https://www.amazon.com:8443/ap/signin')).toBe(false);
		expect(isAllowedOAuthNavigation('https://attacker@www.amazon.com/ap/signin')).toBe(false);
	});
});
