import type dns from 'node:dns';
import type https from 'node:https';
import type net from 'node:net';
import { MAX_IMAGE_BYTES } from './types';

export const MAX_REMOTE_IMAGES = 20;
export const REMOTE_FETCH_TIMEOUT_MS = 15_000;
export const REMOTE_FETCH_INACTIVITY_MS = 5_000;
export const MAX_REMOTE_REDIRECTS = 3;

export type RemoteImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface RemoteImageResponse {
	data: Uint8Array;
	mediaType: RemoteImageMediaType;
	finalUrl: string;
}

export type RemoteFetchErrorCode =
	| 'invalid-url'
	| 'blocked-address'
	| 'dns-failed'
	| 'timeout'
	| 'too-many-redirects'
	| 'cross-origin-redirect'
	| 'http-error'
	| 'invalid-content-type'
	| 'unsupported-encoding'
	| 'response-too-large'
	| 'request-failed';

export class RemoteImageFetchError extends Error {
	constructor(readonly code: RemoteFetchErrorCode, message: string) {
		super(message);
		this.name = 'RemoteImageFetchError';
	}
}

export interface RemoteIncomingMessage {
	statusCode?: number;
	headers: Record<string, string | string[] | undefined>;
	on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
	on(event: 'end', listener: () => void): unknown;
	on(event: 'error', listener: () => void): unknown;
	on(event: 'aborted', listener: () => void): unknown;
	destroy(error?: Error): void;
	resume(): void;
}

export interface RemoteClientRequest {
	on(event: 'error', listener: () => void): unknown;
	on(event: 'timeout', listener: () => void): unknown;
	setTimeout(timeoutMs: number): unknown;
	destroy(error?: Error): void;
	end(): void;
}

export type RemoteRequestFactory = (
	options: https.RequestOptions,
	onResponse: (response: RemoteIncomingMessage) => void,
) => RemoteClientRequest;

export type RemoteDnsResolver = (hostname: string) => Promise<dns.LookupAddress[]>;

export interface RemoteFetchDependencies {
	resolve?: RemoteDnsResolver;
	request?: RemoteRequestFactory;
	timeoutMs?: number;
	maxBytes?: number;
	maxRedirects?: number;
	deadlineAt?: number;
	signal?: AbortSignal;
}

const BLOCKED_HOSTS = new Set([
	'localhost',
	'metadata.google.internal',
	'metadata.aws.internal',
	'instance-data',
]);

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

let unsafeIpv4Addresses: net.BlockList | null = null;
let unsafeIpv6Addresses: net.BlockList | null = null;

function getUnsafeIpv4Addresses(): net.BlockList {
	if (unsafeIpv4Addresses) return unsafeIpv4Addresses;
	const nodeNet = window.require('net') as typeof net;
	const list = new nodeNet.BlockList();
	for (const [address, prefix] of [
		['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
		['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
		['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
		['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
		['224.0.0.0', 4], ['240.0.0.0', 4],
	] as const) list.addSubnet(address, prefix, 'ipv4');
	unsafeIpv4Addresses = list;
	return list;
}

function getUnsafeIpv6Addresses(): net.BlockList {
	if (unsafeIpv6Addresses) return unsafeIpv6Addresses;
	const nodeNet = window.require('net') as typeof net;
	const list = new nodeNet.BlockList();
	for (const [address, prefix] of [
		['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
		['100::', 64], ['100:0:0:1::', 64],
		['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
		['2620:4f:8000::', 48], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
	] as const) list.addSubnet(address, prefix, 'ipv6');
	unsafeIpv6Addresses = list;
	return list;
}

export function isPublicIpAddress(address: string): boolean {
	const nodeNet = window.require('net') as typeof net;
	const family = nodeNet.isIP(address);
	if (family === 4) return !getUnsafeIpv4Addresses().check(address, 'ipv4');
	if (family !== 6 || getUnsafeIpv6Addresses().check(address, 'ipv6')) return false;
	const firstHextet = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
	return Number.isFinite(firstHextet) && firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

export function validateRemoteImageUrl(input: string): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new RemoteImageFetchError('invalid-url', 'Remote image URL is invalid.');
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port) {
		throw new RemoteImageFetchError('invalid-url', 'Remote images require a standard HTTPS URL.');
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!hostname || BLOCKED_HOSTS.has(hostname) || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
		throw new RemoteImageFetchError('blocked-address', 'Remote image host is not public.');
	}
	url.hostname = hostname;
	url.hash = '';
	return url;
}

function networkHostname(url: URL): string {
	return url.hostname.startsWith('[') && url.hostname.endsWith(']')
		? url.hostname.slice(1, -1)
		: url.hostname;
}

function defaultResolver(hostname: string): Promise<dns.LookupAddress[]> {
	const nodeDns = window.require('dns') as typeof dns;
	return nodeDns.promises.lookup(hostname, { all: true, order: 'verbatim' });
}

function defaultRequestFactory(
	options: https.RequestOptions,
	onResponse: (response: RemoteIncomingMessage) => void,
): RemoteClientRequest {
	const nodeHttps = window.require('https') as typeof https;
	return nodeHttps.request(options, (response) => onResponse(response));
}

function withDeadline<T>(promise: Promise<T>, remainingMs: number, signal?: AbortSignal): Promise<T> {
	if (remainingMs <= 0) return Promise.reject(new RemoteImageFetchError('timeout', 'Remote image request timed out.'));
	if (signal?.aborted) return Promise.reject(new RemoteImageFetchError('request-failed', 'Remote image request was cancelled.'));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(new RemoteImageFetchError('request-failed', 'Remote image request was cancelled.')));
		const timer = window.setTimeout(
			() => finish(() => reject(new RemoteImageFetchError('timeout', 'Remote image request timed out.'))),
			remainingMs,
		);
		signal?.addEventListener('abort', onAbort, { once: true });
		if (signal?.aborted) onAbort();
		promise.then(
			(value) => finish(() => resolve(value)),
			() => finish(() => reject(new RemoteImageFetchError('dns-failed', 'Remote image DNS lookup failed.'))),
		);
	});
}

async function resolvePublicAddresses(
	hostname: string,
	resolver: RemoteDnsResolver,
	remainingMs: number,
	signal?: AbortSignal,
): Promise<dns.LookupAddress[]> {
	const nodeNet = window.require('net') as typeof net;
	const literalFamily = nodeNet.isIP(hostname);
	const addresses = literalFamily
		? [{ address: hostname, family: literalFamily }]
		: await withDeadline(resolver(hostname), remainingMs, signal);
	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
		throw new RemoteImageFetchError('blocked-address', 'Remote image host resolves to a blocked address.');
	}
	return addresses;
}

function createPinnedLookup(addresses: dns.LookupAddress[]): net.LookupFunction {
	return (_hostname, options, callback) => {
		const family = options.family === 4 || options.family === 6 ? options.family : 0;
		const candidates = family === 0 ? addresses : addresses.filter((item) => item.family === family);
		if (candidates.length === 0) {
			const error = new Error('No validated address for requested family') as NodeJS.ErrnoException;
			error.code = 'ENOTFOUND';
			callback(error, '', 0);
			return;
		}
		if (options.all) callback(null, candidates);
		else callback(null, candidates[0]?.address ?? '', candidates[0]?.family ?? 0);
	};
}

function headerValue(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function mediaTypeFromHeader(value: string): RemoteImageMediaType | null {
	const normalized = value.split(';', 1)[0]?.trim().toLowerCase();
	return normalized === 'image/jpeg' || normalized === 'image/png'
		|| normalized === 'image/gif' || normalized === 'image/webp'
		? normalized : null;
}

function requestOnce(
	url: URL,
	addresses: dns.LookupAddress[],
	requestFactory: RemoteRequestFactory,
	remainingMs: number,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<{ response?: RemoteImageResponse; redirect?: string }> {
	if (remainingMs <= 0) return Promise.reject(new RemoteImageFetchError('timeout', 'Remote image request timed out.'));
	if (signal?.aborted) return Promise.reject(new RemoteImageFetchError('request-failed', 'Remote image request was cancelled.'));
	const requestDeadline = Date.now() + remainingMs;
	return new Promise((resolve, reject) => {
		let settled = false;
		let deadline: number | null = null;
		let response: RemoteIncomingMessage | null = null;
		const settle = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			if (deadline !== null) window.clearTimeout(deadline);
			signal?.removeEventListener('abort', onAbort);
			callback();
		};
		const fail = (code: RemoteFetchErrorCode, message: string): void => {
			settle(() => reject(new RemoteImageFetchError(code, message)));
		};

		let request: RemoteClientRequest | null = null;
		const onAbort = (): void => {
			fail('request-failed', 'Remote image request was cancelled.');
			try { response?.destroy(); } catch { /* Response may already be closed. */ }
			try { request?.destroy(); } catch { /* Request may already be closed. */ }
		};
		try {
			const hostname = networkHostname(url);
			const nodeNet = window.require('net') as typeof net;
			request = requestFactory({
				protocol: 'https:',
				hostname,
				servername: nodeNet.isIP(hostname) === 0 ? hostname : undefined,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				agent: false,
				rejectUnauthorized: true,
				lookup: createPinnedLookup(addresses),
				headers: {
					Accept: 'image/jpeg,image/png,image/gif,image/webp',
					'Accept-Encoding': 'identity',
					'User-Agent': 'NotesToKindle',
				},
			}, (incoming) => {
				response = incoming;
				const status = incoming.statusCode ?? 0;
				if ([301, 302, 303, 307, 308].includes(status)) {
					const location = headerValue(incoming.headers.location);
					if (!location) fail('http-error', 'Remote image redirect is missing its destination.');
					else settle(() => resolve({ redirect: location }));
					incoming.destroy();
					request?.destroy();
					return;
				}
				if (status !== 200) {
					fail('http-error', `Remote image request failed with HTTP ${status}.`);
					incoming.destroy();
					request?.destroy();
					return;
				}
				const encoding = headerValue(incoming.headers['content-encoding']).trim().toLowerCase();
				if (encoding && encoding !== 'identity') {
					incoming.destroy();
					fail('unsupported-encoding', 'Compressed remote image responses are not accepted.');
					return;
				}
				const mediaType = mediaTypeFromHeader(headerValue(incoming.headers['content-type']));
				if (!mediaType) {
					incoming.destroy();
					fail('invalid-content-type', 'Remote response is not a supported raster image.');
					return;
				}
				const rawLength = headerValue(incoming.headers['content-length']);
				if (rawLength) {
					const contentLength = Number(rawLength);
					if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
						incoming.destroy();
						fail('response-too-large', 'Remote image exceeds the download limit.');
						return;
					}
				}
				const chunks: Buffer[] = [];
				let received = 0;
				incoming.on('data', (chunk) => {
					if (settled) return;
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					received += buffer.byteLength;
					if (received > maxBytes) {
						incoming.destroy();
						fail('response-too-large', 'Remote image exceeds the download limit.');
						return;
					}
					chunks.push(buffer);
				});
				incoming.on('end', () => {
					if (received === 0) {
						fail('request-failed', 'Remote image response was empty.');
						return;
					}
					const data = Buffer.concat(chunks, received);
					settle(() => resolve({ response: { data: new Uint8Array(data), mediaType, finalUrl: url.href } }));
				});
				incoming.on('error', () => fail('request-failed', 'Remote image response failed.'));
				incoming.on('aborted', () => fail('request-failed', 'Remote image response was aborted.'));
			});
		} catch {
			fail('request-failed', 'Remote image request could not be created.');
			return;
		}

		try {
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			const finalRemainingMs = requestDeadline - Date.now();
			if (finalRemainingMs <= 0) {
				fail('timeout', 'Remote image request timed out.');
				request.destroy();
				return;
			}
			request.on('error', () => fail('request-failed', 'Remote image request failed.'));
			request.on('timeout', () => {
				fail('timeout', 'Remote image request timed out.');
				request.destroy();
			});
			request.setTimeout(Math.min(REMOTE_FETCH_INACTIVITY_MS, finalRemainingMs));
			deadline = window.setTimeout(() => {
				fail('timeout', 'Remote image request timed out.');
				request.destroy();
			}, finalRemainingMs);
			request.end();
		} catch {
			fail('request-failed', 'Remote image request failed.');
			try { request.destroy(); } catch { /* Request setup already failed. */ }
		}
	});
}

export async function fetchRemoteImage(input: string, dependencies?: RemoteFetchDependencies): Promise<RemoteImageResponse> {
	const resolver = dependencies?.resolve ?? defaultResolver;
	const requestFactory = dependencies?.request ?? defaultRequestFactory;
	const timeoutMs = dependencies?.timeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
	const maxBytes = dependencies?.maxBytes ?? MAX_IMAGE_BYTES;
	const maxRedirects = dependencies?.maxRedirects ?? MAX_REMOTE_REDIRECTS;
	const deadline = dependencies?.deadlineAt ?? Date.now() + timeoutMs;
	const signal = dependencies?.signal;
	let url = validateRemoteImageUrl(input);

	for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
		const remaining = deadline - Date.now();
		const addresses = await resolvePublicAddresses(networkHostname(url), resolver, remaining, signal);
		const result = await requestOnce(url, addresses, requestFactory, deadline - Date.now(), maxBytes, signal);
		if (result.response) return result.response;
		if (!result.redirect) throw new RemoteImageFetchError('request-failed', 'Remote image request failed.');
		if (redirectCount === maxRedirects) {
			throw new RemoteImageFetchError('too-many-redirects', 'Remote image has too many redirects.');
		}
		const redirectUrl = validateRemoteImageUrl(new URL(result.redirect, url).href);
		if (redirectUrl.origin !== url.origin) {
			throw new RemoteImageFetchError('cross-origin-redirect', 'Remote image redirect changed origin.');
		}
		url = redirectUrl;
	}
	throw new RemoteImageFetchError('too-many-redirects', 'Remote image has too many redirects.');
}
