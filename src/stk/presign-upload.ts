import { STK_USER_AGENT } from './user-agent';

/**
 * Minimal HTTP surface used for the presigned S3 upload, so the transport can
 * be exercised deterministically in tests. Node's `https.ClientRequest` and
 * `http.IncomingMessage` satisfy these shapes structurally; the Node HTTPS
 * module itself is supplied by the caller (client.ts).
 */

export interface UploadRequestOptions {
	protocol: string;
	hostname: string;
	port: string;
	path: string;
	method: 'PUT';
	headers: Record<string, string>;
}

export interface UploadIncomingMessage {
	statusCode: number | undefined;
	on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
	on(event: 'end', listener: () => void): unknown;
	on(event: 'error', listener: (err: Error) => void): unknown;
	on(event: 'aborted', listener: () => void): unknown;
}

export interface UploadClientRequest {
	on(event: 'response', listener: (response: UploadIncomingMessage) => void): unknown;
	on(event: 'error', listener: (err: Error) => void): unknown;
	on(event: 'timeout', listener: () => void): unknown;
	write(data: Buffer): unknown;
	end(): void;
	setTimeout(timeoutMs: number, callback?: () => void): unknown;
	destroy(error?: Error): void;
}

export type UploadRequestFactory = (options: UploadRequestOptions) => UploadClientRequest;

/**
 * Injectable timer surface so tests can drive the total upload deadline
 * without real timers. The default implementation delegates to
 * `window.setTimeout` / `window.clearTimeout`.
 */
export interface UploadTimer {
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimer: UploadTimer = {
	setTimeout: (callback, ms) => window.setTimeout(callback, ms),
	clearTimeout: (handle) => window.clearTimeout(handle as number),
};

export interface UploadToPresignedUrlOptions {
	timeoutMs?: number;
	maxErrorBodyBytes?: number;
	deadlineMs?: number;
	timer?: UploadTimer;
}

export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
export const UPLOAD_DEADLINE_MS = 30 * 60 * 1000;
export const UPLOAD_MAX_ERROR_BODY_BYTES = 16 * 1024;

export class UploadRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UploadRequestError';
	}
}

/**
 * Uploads `payload` to a validated presigned S3 URL.
 *
 * Any 2xx status is success. Errors are sanitized: they carry only the
 * operation and, when known, the HTTP status — never the remote response
 * body. The response body is still fully consumed (drained) so the socket is
 * released, but at most `maxErrorBodyBytes` are retained in memory. The
 * promise settles exactly once on the first of: a request inactivity timeout,
 * the strict wall-clock deadline (`deadlineMs`, default 30 minutes), transport
 * errors, response errors or aborts. The deadline timer is cleared on every
 * settle. Redirects are never followed: a 3xx is a non-2xx failure.
 */
export function uploadToPresignedUrl(
	url: URL,
	payload: Buffer,
	requestFactory: UploadRequestFactory,
	options?: UploadToPresignedUrlOptions,
): Promise<void> {
	const timeoutMs = options?.timeoutMs ?? UPLOAD_TIMEOUT_MS;
	const deadlineMs = options?.deadlineMs ?? UPLOAD_DEADLINE_MS;
	const timer = options?.timer ?? defaultTimer;
	const maxErrorBodyBytes = options?.maxErrorBodyBytes ?? UPLOAD_MAX_ERROR_BODY_BYTES;

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let deadlineHandle: unknown = null;
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			if (deadlineHandle !== null) timer.clearTimeout(deadlineHandle);
			fn();
		};
		const fail = (message: string): void => {
			settle(() => reject(new UploadRequestError(message)));
		};

		let req: UploadClientRequest;
		try {
			req = requestFactory({
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				path: `${url.pathname}${url.search}`,
				method: 'PUT',
				headers: {
					'Content-Length': String(payload.length),
					'Accept-Encoding': 'gzip, deflate',
					'Accept-Language': 'en-US,*',
					'User-Agent': STK_USER_AGENT,
				},
			});
		} catch {
			fail('Upload failed: request error');
			return;
		}

		try {
			req.setTimeout(timeoutMs);
		} catch {
			fail('Upload failed: request error');
			return;
		}

		deadlineHandle = timer.setTimeout(() => {
			// Settle as the deadline first so a synchronous destroy() (or an
			// error it emits synchronously) cannot win the race.
			settle(() => reject(new UploadRequestError('Upload failed: deadline exceeded')));
			try {
				req.destroy();
			} catch {
				// The socket may already be gone; the settled failure is enough.
			}
		}, deadlineMs);

		req.on('error', () => {
			fail('Upload failed: request error');
		});

		req.on('timeout', () => {
			// Settle as timed out first so a synchronous destroy() (or an
			// error it emits synchronously) cannot win the race.
			fail('Upload failed: request timed out');
			try {
				req.destroy();
			} catch {
				// The socket may already be gone; the settled failure is enough.
			}
		});

		req.on('response', (res) => {
			const statusCode = res.statusCode ?? 0;
			const isSuccess = statusCode >= 200 && statusCode < 300;
			const retained: Buffer[] = [];
			let retainedBytes = 0;

			res.on('data', (chunk) => {
				if (!isSuccess && retainedBytes < maxErrorBodyBytes) {
					const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
					const take = Math.min(buf.length, maxErrorBodyBytes - retainedBytes);
					retained.push(buf.subarray(0, take));
					retainedBytes += take;
				}
			});

			res.on('end', () => {
				if (isSuccess) {
					settle(() => resolve());
					return;
				}
				retained.length = 0;
				fail(`Upload failed: HTTP ${statusCode}`);
			});

			res.on('error', () => {
				fail('Upload failed: response error');
			});

			res.on('aborted', () => {
				fail('Upload failed: response aborted');
			});
		});

		try {
			req.write(payload);
			req.end();
		} catch {
			fail('Upload failed: request error');
		}
	});
}
