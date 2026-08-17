import { describe, expect, it } from 'bun:test';
import type dns from 'node:dns';
import type https from 'node:https';
import {
	fetchRemoteImage,
	isPublicIpAddress,
	RemoteImageFetchError,
	type RemoteClientRequest,
	type RemoteIncomingMessage,
	type RemoteRequestFactory,
	validateRemoteImageUrl,
} from '../src/images/remote-fetch';

class FakeResponse implements RemoteIncomingMessage {
	private readonly dataListeners: Array<(chunk: Buffer | string) => void> = [];
	private readonly endListeners: Array<() => void> = [];
	private readonly errorListeners: Array<() => void> = [];
	private readonly abortedListeners: Array<() => void> = [];
	destroyed = false;

	constructor(
		readonly statusCode: number,
		readonly headers: Record<string, string | string[] | undefined>,
		private readonly body: Buffer,
	) {}

	on(event: 'data' | 'end' | 'error' | 'aborted', listener: ((chunk: Buffer | string) => void) | (() => void)): unknown {
		if (event === 'data') this.dataListeners.push(listener);
		else if (event === 'end') this.endListeners.push(listener as () => void);
		else if (event === 'error') this.errorListeners.push(listener as () => void);
		else this.abortedListeners.push(listener as () => void);
		return this;
	}

	emitBody(chunkSize = this.body.length): void {
		for (let offset = 0; offset < this.body.length && !this.destroyed; offset += chunkSize) {
			const chunk = this.body.subarray(offset, Math.min(offset + chunkSize, this.body.length));
			for (const listener of this.dataListeners) listener(chunk);
		}
		if (!this.destroyed) for (const listener of this.endListeners) listener();
	}

	destroy(): void { this.destroyed = true; }
	resume(): void {}
	emitError(): void { for (const listener of this.errorListeners) listener(); }
	emitAborted(): void { for (const listener of this.abortedListeners) listener(); }
}

class FakeRequest implements RemoteClientRequest {
	private errorListener: (() => void) | null = null;
	private timeoutListener: (() => void) | null = null;
	timeoutMs = 0;
	destroyed = false;

	on(event: 'error' | 'timeout', listener: () => void): unknown {
		if (event === 'error') this.errorListener = listener;
		else this.timeoutListener = listener;
		return this;
	}

	setTimeout(timeoutMs: number): unknown { this.timeoutMs = timeoutMs; return this; }
	destroy(): void { this.destroyed = true; }
	end(): void {}
	emitError(): void { this.errorListener?.(); }
	emitTimeout(): void { this.timeoutListener?.(); }
}

interface PlannedResponse {
	status: number;
	headers?: Record<string, string>;
	body?: Buffer;
	chunkSize?: number;
}

function plannedRequestFactory(
	plans: PlannedResponse[],
	captured: https.RequestOptions[] = [],
	capturedRequests: FakeRequest[] = [],
	capturedResponses: FakeResponse[] = [],
): RemoteRequestFactory {
	return (options, onResponse) => {
		captured.push(options);
		const request = new FakeRequest();
		capturedRequests.push(request);
		const plan = plans.shift();
		if (!plan) throw new Error('No planned response');
		queueMicrotask(() => {
			const response = new FakeResponse(plan.status, plan.headers ?? {}, plan.body ?? Buffer.alloc(0));
			capturedResponses.push(response);
			onResponse(response);
			response.emitBody(plan.chunkSize);
		});
		return request;
	};
}

const PUBLIC_V4: dns.LookupAddress[] = [{ address: '93.184.216.34', family: 4 }];

async function expectCode(promise: Promise<unknown>, code: RemoteImageFetchError['code']): Promise<void> {
	try {
		await promise;
		throw new Error('Expected promise to reject');
	} catch (error) {
		expect(error).toBeInstanceOf(RemoteImageFetchError);
		if (error instanceof RemoteImageFetchError) expect(error.code).toBe(code);
	}
}

describe('remote image URL and address policy', () => {
	it('accepts ordinary public IPv4 and IPv6 addresses', () => {
		expect(isPublicIpAddress('8.8.8.8')).toBe(true);
		expect(isPublicIpAddress('1.1.1.1')).toBe(true);
		expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
	});

	it('blocks local, private, documentation, transition and multicast ranges', () => {
		for (const address of [
			'0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
			'172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
			'192.88.99.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
			'192.31.196.1', '192.52.193.1', '192.175.48.1',
			'::', '::1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b:1::1', '100::1', '100:0:0:1::1', '2001::1',
			'2001:db8::1', '2002:0808:0808::', '2620:4f:8000::1', '3fff::1', 'fc00::1', 'fe80::1', 'ff02::1',
		]) expect(isPublicIpAddress(address), address).toBe(false);
	});

	it('rejects schemes, credentials, ports and local hostnames', () => {
		for (const url of [
			'http://cdn.example/image.png',
			'https://user:pass@cdn.example/image.png',
			'https://cdn.example:8443/image.png',
			'https://localhost/image.png',
			'https://service.internal/image.png',
			'https://printer.local/image.png',
			'file:///tmp/image.png',
		]) expect(() => validateRemoteImageUrl(url), url).toThrow();
	});

	it('normalizes a valid HTTPS URL and removes fragments', () => {
		const url = validateRemoteImageUrl('https://CDN.Example./path/image.png?q=1#secret');
		expect(url.href).toBe('https://cdn.example/path/image.png?q=1');
	});
});

describe('fetchRemoteImage', () => {
	it('pins the validated DNS answer while preserving the TLS hostname', async () => {
		const captured: https.RequestOptions[] = [];
		const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
		const result = await fetchRemoteImage('https://cdn.example/image.jpg?token=opaque', {
			resolve: async () => PUBLIC_V4,
			request: plannedRequestFactory([{
				status: 200,
				headers: { 'content-type': 'image/jpeg', 'content-length': String(data.length) },
				body: data,
			}], captured),
		});

		expect(result.mediaType).toBe('image/jpeg');
		expect(result.data).toEqual(new Uint8Array(data));
		expect(captured).toHaveLength(1);
		expect(captured[0]?.hostname).toBe('cdn.example');
		expect(captured[0]?.servername).toBe('cdn.example');
		expect(captured[0]?.path).toBe('/image.jpg?token=opaque');
		expect(captured[0]?.agent).toBe(false);
		expect(captured[0]?.headers).toMatchObject({ 'Accept-Encoding': 'identity' });

		const lookup = captured[0]?.lookup;
		expect(lookup).toBeFunction();
		if (lookup) {
			await new Promise<void>((resolve, reject) => {
				lookup('cdn.example', { all: true }, (error, addresses) => {
					if (error) { reject(error); return; }
					expect(addresses).toEqual(PUBLIC_V4);
					resolve();
				});
			});
		}
	});

	it('rejects a mixed public/private DNS answer before opening a request', async () => {
		let requestCount = 0;
		await expectCode(fetchRemoteImage('https://cdn.example/image.png', {
			resolve: async () => [...PUBLIC_V4, { address: '127.0.0.1', family: 4 }],
			request: () => { requestCount += 1; return new FakeRequest(); },
		}), 'blocked-address');
		expect(requestCount).toBe(0);
	});

	it('revalidates redirect destinations and blocks private targets', async () => {
		let requestCount = 0;
		let resolutionCount = 0;
		const request = plannedRequestFactory([{
			status: 302,
			headers: { location: '/metadata' },
		}]);
		await expectCode(fetchRemoteImage('https://cdn.example/image.png', {
			resolve: async () => {
				resolutionCount += 1;
				return resolutionCount === 1 ? PUBLIC_V4 : [{ address: '127.0.0.1', family: 4 }];
			},
			request: (options, onResponse) => { requestCount += 1; return request(options, onResponse); },
		}), 'blocked-address');
		expect(requestCount).toBe(1);
	});

	it('re-resolves and revalidates every same-origin redirect hop', async () => {
		const resolved: string[] = [];
		const captured: https.RequestOptions[] = [];
		const result = await fetchRemoteImage('https://first.example/image', {
			resolve: async (hostname) => { resolved.push(hostname); return PUBLIC_V4; },
			request: plannedRequestFactory([
				{ status: 302, headers: { location: '/final.png' } },
				{ status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('png') },
			], captured),
		});
		expect(resolved).toEqual(['first.example', 'first.example']);
		expect(captured.map((item) => item.hostname)).toEqual(['first.example', 'first.example']);
		expect(result.finalUrl).toBe('https://first.example/final.png');
	});

	it('rejects cross-origin redirects without contacting the destination', async () => {
		const resolved: string[] = [];
		await expectCode(fetchRemoteImage('https://first.example/image', {
			resolve: async (hostname) => { resolved.push(hostname); return PUBLIC_V4; },
			request: plannedRequestFactory([{
				status: 302,
				headers: { location: 'https://second.example/tracker.png' },
			}]),
		}), 'cross-origin-redirect');
		expect(resolved).toEqual(['first.example']);
	});

	it('destroys redirect and HTTP error responses instead of draining their bodies', async () => {
		const redirectRequests: FakeRequest[] = [];
		const redirectResponses: FakeResponse[] = [];
		await expectCode(fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: plannedRequestFactory(
				[{ status: 302, headers: { location: 'https://other.example/image' }, body: Buffer.alloc(1024) }],
				[],
				redirectRequests,
				redirectResponses,
			),
		}), 'cross-origin-redirect');
		expect(redirectResponses[0]?.destroyed).toBe(true);
		expect(redirectRequests[0]?.destroyed).toBe(true);

		const errorRequests: FakeRequest[] = [];
		const errorResponses: FakeResponse[] = [];
		await expectCode(fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: plannedRequestFactory(
				[{ status: 404, body: Buffer.alloc(1024) }],
				[],
				errorRequests,
				errorResponses,
			),
		}), 'http-error');
		expect(errorResponses[0]?.destroyed).toBe(true);
		expect(errorRequests[0]?.destroyed).toBe(true);
	});

	it('aborts DNS and active requests without opening or retaining sockets', async () => {
		const dnsController = new AbortController();
		let dnsRequestCount = 0;
		const dnsPromise = fetchRemoteImage('https://cdn.example/image', {
			resolve: () => new Promise(() => void 0),
			request: () => { dnsRequestCount += 1; return new FakeRequest(); },
			signal: dnsController.signal,
		});
		dnsController.abort();
		await expectCode(dnsPromise, 'request-failed');
		expect(dnsRequestCount).toBe(0);

		const requestController = new AbortController();
		const requests: FakeRequest[] = [];
		const requestPromise = fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: (_options, _onResponse) => {
				const request = new FakeRequest();
				requests.push(request);
				return request;
			},
			signal: requestController.signal,
		});
		for (let attempt = 0; attempt < 10 && requests.length === 0; attempt += 1) await Promise.resolve();
		requestController.abort();
		await expectCode(requestPromise, 'request-failed');
		expect(requests[0]?.destroyed).toBe(true);
	});

	it('does not create a request after the absolute deadline', async () => {
		let requestCount = 0;
		await expectCode(fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: () => { requestCount += 1; return new FakeRequest(); },
			deadlineAt: Date.now() - 1,
		}), 'timeout');
		expect(requestCount).toBe(0);
	});

	it('settles request timeout and transport errors with sanitized codes', async () => {
		const timeoutRequests: FakeRequest[] = [];
		const timeoutPromise = fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: () => {
				const request = new FakeRequest();
				timeoutRequests.push(request);
				return request;
			},
		});
		for (let attempt = 0; attempt < 10 && timeoutRequests.length === 0; attempt += 1) await Promise.resolve();
		timeoutRequests[0]?.emitTimeout();
		await expectCode(timeoutPromise, 'timeout');
		expect(timeoutRequests[0]?.destroyed).toBe(true);

		const errorRequests: FakeRequest[] = [];
		const errorPromise = fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: () => {
				const request = new FakeRequest();
				errorRequests.push(request);
				return request;
			},
		});
		for (let attempt = 0; attempt < 10 && errorRequests.length === 0; attempt += 1) await Promise.resolve();
		errorRequests[0]?.emitError();
		await expectCode(errorPromise, 'request-failed');
	});

	it('handles response errors and aborts exactly once', async () => {
		for (const event of ['error', 'aborted'] as const) {
			let response: FakeResponse | null = null;
			const promise = fetchRemoteImage('https://cdn.example/image', {
				resolve: async () => PUBLIC_V4,
				request: (_options, onResponse) => {
					const request = new FakeRequest();
					queueMicrotask(() => {
						response = new FakeResponse(200, { 'content-type': 'image/png' }, Buffer.alloc(0));
						onResponse(response);
						if (event === 'error') response.emitError();
						else response.emitAborted();
					});
					return request;
				},
			});
			await expectCode(promise, 'request-failed');
			expect(response).not.toBeNull();
		}
	});

	it('enforces the active request deadline and destroys the socket', async () => {
		const requests: FakeRequest[] = [];
		await expectCode(fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: () => {
				const request = new FakeRequest();
				requests.push(request);
				return request;
			},
			timeoutMs: 5,
		}), 'timeout');
		expect(requests[0]?.destroyed).toBe(true);
	});

	it('rejects unsupported encodings and media types', async () => {
		await expectCode(fetchRemoteImage('https://cdn.example/image', {
			resolve: async () => PUBLIC_V4,
			request: plannedRequestFactory([{
				status: 200,
				headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' },
				body: Buffer.from('compressed'),
			}]),
		}), 'unsupported-encoding');

		await expectCode(fetchRemoteImage('https://cdn.example/page', {
			resolve: async () => PUBLIC_V4,
			request: plannedRequestFactory([{
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: Buffer.from('<html>'),
			}]),
		}), 'invalid-content-type');
	});

	it('enforces content-length and streaming byte limits', async () => {
		await expectCode(fetchRemoteImage('https://cdn.example/image.png', {
			resolve: async () => PUBLIC_V4,
			maxBytes: 4,
			request: plannedRequestFactory([{
				status: 200,
				headers: { 'content-type': 'image/png', 'content-length': '5' },
				body: Buffer.alloc(5),
			}]),
		}), 'response-too-large');

		await expectCode(fetchRemoteImage('https://cdn.example/image.png', {
			resolve: async () => PUBLIC_V4,
			maxBytes: 4,
			request: plannedRequestFactory([{
				status: 200,
				headers: { 'content-type': 'image/png' },
				body: Buffer.alloc(5),
				chunkSize: 2,
			}]),
		}), 'response-too-large');
	});

	it('stops after the configured redirect budget', async () => {
		await expectCode(fetchRemoteImage('https://cdn.example/start', {
			resolve: async () => PUBLIC_V4,
			maxRedirects: 1,
			request: plannedRequestFactory([
				{ status: 302, headers: { location: '/one' } },
				{ status: 302, headers: { location: '/two' } },
			]),
		}), 'too-many-redirects');
	});
});
