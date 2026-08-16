/**
 * Wiring for the OAuth authorization window's navigation gates.
 *
 * Both `will-navigate` (top-level navigation) and `will-redirect` (server 3xx
 * redirects inside the page) are gated against the exact allowed Amazon login
 * hosts. The final authorization redirect is captured through the
 * caller-provided `checkRedirect`, which both validates the URL and settles
 * the flow; a matching redirect is also prevented from actually being
 * navigated to. Any navigation or redirect that leaves the allowed hosts is
 * prevented and funnels into the single fixed `onExternalNavigation` callback,
 * so the caller settles the flow exactly once with a sanitized error.
 *
 * No Electron types are imported: the webContents surface is duck-typed as an
 * EventEmitter-like target so the wiring can be exercised deterministically
 * against a plain fake in tests.
 */

export interface EventEmitterLike {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface NavigationEvent {
	preventDefault: () => void;
}

export interface OAuthNavigationGuard {
	/** True only for HTTPS top-level navigations on the exact allowed hosts. */
	isAllowedNavigation: (url: string) => boolean;
	/**
	 * True when the URL is the final authorization redirect. The caller is
	 * responsible for validating the URL and settling the flow; a `true`
	 * result also prevents the redirect itself from being navigated to.
	 */
	checkRedirect: (url: string) => boolean;
	/** Invoked for every prevented external navigation or redirect. */
	onExternalNavigation: () => void;
}

export function wireOAuthNavigation(
	webContents: EventEmitterLike,
	guard: OAuthNavigationGuard,
): void {
	webContents.on('will-navigate', (...args: unknown[]) => {
		const event = args[0] as NavigationEvent | undefined;
		const url = args[1] as string | undefined;
		if (typeof url === 'string' && guard.isAllowedNavigation(url)) return;
		event?.preventDefault();
		guard.onExternalNavigation();
	});

	webContents.on('will-redirect', (...args: unknown[]) => {
		const event = args[0] as NavigationEvent | undefined;
		const url = args[1] as string | undefined;
		if (typeof url === 'string' && guard.checkRedirect(url)) {
			event?.preventDefault();
			return;
		}
		if (typeof url === 'string' && guard.isAllowedNavigation(url)) return;
		event?.preventDefault();
		guard.onExternalNavigation();
	});
}
