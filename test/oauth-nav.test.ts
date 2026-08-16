import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'bun:test';
import { isAllowedOAuthNavigation, isRedirectUrl } from '../src/stk/redirect';
import { wireOAuthNavigation, type NavigationEvent } from '../src/stk/navigation';

const VALID_REDIRECT =
	'https://www.amazon.com/gp/sendtokindle?openid.oa2.authorization_code=Atza|IwEBIPVaLQVF3cOWpBXDcTOkT4ivRYPGAvHXKBKLnFFYmqhJ7';

class FakeWebContents extends EventEmitter {}

type Guarded = {
	fire: (event: 'will-navigate' | 'will-redirect', url: string) => void;
	prevented: Array<{ event: string; url: string }>;
	externalCalls: () => number;
	checkedRedirects: string[];
	checkedNavigations: string[];
	lastCapturedRedirect: () => string;
};

function makeGuarded(): Guarded {
	const wc = new FakeWebContents();
	const prevented: Array<{ event: string; url: string }> = [];
	let externalCalls = 0;
	const checkedRedirects: string[] = [];
	const checkedNavigations: string[] = [];
	let lastCapturedRedirect = '';

	wireOAuthNavigation(wc, {
		isAllowedNavigation: (url) => {
			checkedNavigations.push(url);
			return isAllowedOAuthNavigation(url);
		},
		checkRedirect: (url) => {
			checkedRedirects.push(url);
			if (!isRedirectUrl(url)) return false;
			lastCapturedRedirect = url;
			return true;
		},
		onExternalNavigation: () => {
			externalCalls += 1;
		},
	});

	return {
		fire: (event, url) => {
			const navEvent: NavigationEvent = {
				preventDefault: () => prevented.push({ event, url }),
			};
			wc.emit(event, navEvent, url);
		},
		prevented,
		externalCalls: () => externalCalls,
		checkedRedirects,
		checkedNavigations,
		lastCapturedRedirect: () => lastCapturedRedirect,
	};
}

describe('wireOAuthNavigation', () => {
	it('prevents a direct external navigation and invokes the blocked callback', () => {
		const g = makeGuarded();
		g.fire('will-navigate', 'https://evil.example/phish');
		expect(g.prevented).toEqual([{ event: 'will-navigate', url: 'https://evil.example/phish' }]);
		expect(g.externalCalls()).toBe(1);
		expect(g.checkedRedirects).toEqual([]);
	});

	it('prevents an external 3xx redirect and invokes the blocked callback', () => {
		const g = makeGuarded();
		g.fire('will-redirect', 'https://evil.example/steal');
		expect(g.prevented).toEqual([{ event: 'will-redirect', url: 'https://evil.example/steal' }]);
		expect(g.externalCalls()).toBe(1);
	});

	it('captures and prevents a valid callback 3xx redirect without blocking the flow', () => {
		const g = makeGuarded();
		g.fire('will-redirect', VALID_REDIRECT);
		expect(g.lastCapturedRedirect()).toBe(VALID_REDIRECT);
		expect(g.prevented).toEqual([{ event: 'will-redirect', url: VALID_REDIRECT }]);
		expect(g.externalCalls()).toBe(0);
	});

	it('lets an allowed internal Amazon redirect continue untouched', () => {
		const g = makeGuarded();
		g.fire('will-redirect', 'https://www.amazon.com/ap/signin?openid.mode=checkid_setup');
		expect(g.prevented).toEqual([]);
		expect(g.externalCalls()).toBe(0);
		expect(g.lastCapturedRedirect()).toBe('');
	});

	it('lets an allowed Amazon navigation continue untouched', () => {
		const g = makeGuarded();
		g.fire('will-navigate', 'https://www.amazon.com/ap/signin?openid.mode=checkid_setup');
		expect(g.prevented).toEqual([]);
		expect(g.externalCalls()).toBe(0);
	});

	it('routes duplicate blocked events through the caller settle guard so the flow settles once', () => {
		const wc = new FakeWebContents();
		let settleCount = 0;
		let outcome = '';
		const done = (fn: () => void): void => {
			if (settleCount > 0) return;
			settleCount += 1;
			fn();
		};

		wireOAuthNavigation(wc, {
			isAllowedNavigation: isAllowedOAuthNavigation,
			checkRedirect: (url) => {
				if (!isRedirectUrl(url)) return false;
				done(() => {
					outcome = 'code';
				});
				return true;
			},
			onExternalNavigation: () =>
				done(() => {
					outcome = 'blocked';
				}),
		});

		wc.emit('will-navigate', { preventDefault() {} }, 'https://evil.example/a');
		wc.emit('will-redirect', { preventDefault() {} }, 'https://evil.example/b');
		expect(outcome).toBe('blocked');
		expect(settleCount).toBe(1);

		// A late callback redirect must not overwrite the settled outcome.
		wc.emit('will-redirect', { preventDefault() {} }, VALID_REDIRECT);
		expect(outcome).toBe('blocked');
		expect(settleCount).toBe(1);
	});

	it('treats a missing URL argument as external and blocks it', () => {
		const wc = new FakeWebContents();
		let external = 0;
		wireOAuthNavigation(wc, {
			isAllowedNavigation: isAllowedOAuthNavigation,
			checkRedirect: () => false,
			onExternalNavigation: () => {
				external += 1;
			},
		});
		wc.emit('will-navigate', { preventDefault() {} });
		wc.emit('will-redirect', { preventDefault() {} });
		expect(external).toBe(2);
	});
});
