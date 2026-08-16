import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
	UploadRequestError,
	UPLOAD_MAX_ERROR_BODY_BYTES,
	UPLOAD_TIMEOUT_MS,
	uploadToPresignedUrl,
	type UploadClientRequest,
	type UploadIncomingMessage,
	type UploadRequestFactory,
	type UploadRequestOptions,
	type UploadToPresignedUrlOptions,
} from '../src/stk/presign-upload';

const TEST_PAYLOAD = Buffer.from('file-content');

class FakeResponse extends EventEmitter implements UploadIncomingMessage {
	statusCode: number;

	constructor(statusCode: number) {
		super();
		this.statusCode = statusCode;
	}

	push(chunk: Buffer | string): void {
		this.emit('data', chunk);
	}

	finish(): void {
		this.emit('end');
	}

	fail(error: Error): void {
		this.emit('error', error);
	}

	abort(): void {
		this.emit('aborted');
	}
}

class FakeRequest extends EventEmitter implements UploadClientRequest {
	options: UploadRequestOptions;
	timeoutMs: number | undefined;
	payload: Buffer | null = null;
	ended = false;
	destroyed = false;

	constructor(options: UploadRequestOptions) {
		super();
		this.options = options;
	}

	write(data: Buffer): boolean {
		this.payload = data;
		return true;
	}

	end(): void {
		this.ended = true;
	}

	setTimeout(timeoutMs: number): this {
		this.timeoutMs = timeoutMs;
		return this;
	}

	destroy(error?: Error): void {
		this.destroyed = true;
		if (error !== undefined) this.emit('error', error);
	}
}

class DestroyEmitsErrorRequest extends FakeRequest {
	destroy(): void {
		this.destroyed = true;
		this.emit('error', new Error('ECONNRESET'));
	}
}

class ThrowingSetTimeoutRequest extends FakeRequest {
	setTimeout(): this {
		throw new Error('sync setTimeout failure');
	}
}

class ThrowingWriteRequest extends FakeRequest {
	write(): boolean {
		throw new Error('sync write failure');
	}
}

class ThrowingEndRequest extends FakeRequest {
	end(): void {
		throw new Error('sync end failure');
	}
}

function makeHarness(
	options?: UploadToPresignedUrlOptions,
	requestCtor: new (opts: UploadRequestOptions) => FakeRequest = FakeRequest,
): {
	request: FakeRequest;
	promise: Promise<void>;
	url: URL;
} {
	let captured: FakeRequest | null = null;
	const factory: UploadRequestFactory = (opts) => {
		captured = new requestCtor(opts);
		return captured;
	};
	const url = new URL(
		'https://bucket.s3.amazonaws.com/some/key.epub?X-Amz-Signature=abc&part=1',
	);
	const promise = uploadToPresignedUrl(url, TEST_PAYLOAD, factory, options);
	if (captured === null) throw new Error('request factory was not invoked');
	return { request: captured, promise, url };
}

async function rejectionOf(promise: Promise<void>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

function expectRejectsWith(promise: Promise<void>, message: string): Promise<void> {
	return rejectionOf(promise).then((error) => {
		expect(error).toBeInstanceOf(UploadRequestError);
		expect((error as Error).message).toBe(message);
	});
}

describe('uploadToPresignedUrl', () => {
	it('accepts any 2xx status', async () => {
		for (const status of [200, 201, 204, 299]) {
			const { request, promise } = makeHarness();
			const res = new FakeResponse(status);
			request.emit('response', res);
			if (status !== 204) res.push(Buffer.from('created'));
			res.finish();
			await promise;
		}
	});

	it('rejects non-2xx statuses (including redirects) with operation and status only', async () => {
		for (const status of [301, 302, 400, 401, 403, 404, 500, 503]) {
			const { request, promise } = makeHarness();
			const res = new FakeResponse(status);
			request.emit('response', res);
			res.finish();
			const error = await rejectionOf(promise);
			expect(error).toBeInstanceOf(UploadRequestError);
			expect((error as Error).message).toBe(`Upload failed: HTTP ${status}`);
		}
	});

	it('never embeds the remote response body in thrown errors', async () => {
		const { request, promise } = makeHarness();
		const res = new FakeResponse(500);
		request.emit('response', res);
		res.push(Buffer.from('SENSITIVE_SECRET_DATA_IN_BODY'));
		res.finish();
		const error = await rejectionOf(promise);
		expect((error as Error).message).toBe('Upload failed: HTTP 500');
		expect(String(error)).not.toContain('SENSITIVE_SECRET_DATA_IN_BODY');
	});

	it('caps retained error body bytes while draining the remainder', async () => {
		const { request, promise } = makeHarness();
		const res = new FakeResponse(500);
		request.emit('response', res);
		let delivered = 0;
		res.on('data', () => {
			delivered += 1;
		});
		const chunk = Buffer.alloc(4 * 1024, 0x61);
		const chunkCount = Math.ceil((UPLOAD_MAX_ERROR_BODY_BYTES * 4) / chunk.length);
		for (let i = 0; i < chunkCount; i += 1) res.push(chunk);
		res.finish();
		const error = await rejectionOf(promise);
		expect((error as Error).message).toBe('Upload failed: HTTP 500');
		expect(delivered).toBe(chunkCount);
	});

	it('rejects when the request times out and settles once', async () => {
		const { request, promise } = makeHarness({ timeoutMs: 1000 });
		expect(request.timeoutMs).toBe(1000);
		request.emit('timeout');
		request.emit('error', new Error('late transport error'));
		expect(request.destroyed).toBe(true);
		await expectRejectsWith(promise, 'Upload failed: request timed out');
	});

	it('uses the default inactivity timeout when none is configured', async () => {
		const { request, promise } = makeHarness();
		expect(request.timeoutMs).toBe(UPLOAD_TIMEOUT_MS);
		request.emit('timeout');
		await expectRejectsWith(promise, 'Upload failed: request timed out');
	});

	it('rejects on request transport errors', async () => {
		const { request, promise } = makeHarness();
		request.emit('error', new Error('socket hang up'));
		await expectRejectsWith(promise, 'Upload failed: request error');
	});

	it('rejects on response errors', async () => {
		const { request, promise } = makeHarness();
		const res = new FakeResponse(200);
		request.emit('response', res);
		res.fail(new Error('connection reset'));
		await expectRejectsWith(promise, 'Upload failed: response error');
	});

	it('rejects when the response is aborted', async () => {
		const { request, promise } = makeHarness();
		const res = new FakeResponse(200);
		request.emit('response', res);
		res.abort();
		await expectRejectsWith(promise, 'Upload failed: response aborted');
	});

	it('settles once when terminal events race', async () => {
		const failed = makeHarness();
		const failingRes = new FakeResponse(200);
		failed.request.emit('response', failingRes);
		failingRes.fail(new Error('boom'));
		failingRes.finish();
		await expectRejectsWith(failed.promise, 'Upload failed: response error');

		const succeeded = makeHarness();
		const okRes = new FakeResponse(201);
		succeeded.request.emit('response', okRes);
		okRes.finish();
		okRes.fail(new Error('late'));
		await succeeded.promise;
	});

	it('sends PUT with the validated URL components, headers and body', async () => {
		const { request, promise, url } = makeHarness();
		const res = new FakeResponse(200);
		request.emit('response', res);
		res.finish();
		await promise;
		expect(request.options).toEqual({
			protocol: 'https:',
			hostname: 'bucket.s3.amazonaws.com',
			port: '',
			path: `${url.pathname}${url.search}`,
			method: 'PUT',
			headers: {
				'Content-Length': String(TEST_PAYLOAD.length),
				'Accept-Encoding': 'gzip, deflate',
				'Accept-Language': 'en-US,*',
				'User-Agent': 'Mozilla/5.0 (compatible; Agent/send-to-kindle)',
			},
		});
		expect(request.payload).toEqual(TEST_PAYLOAD);
		expect(request.ended).toBe(true);
	});

	it('does not follow redirects', async () => {
		const { request, promise } = makeHarness();
		const res = new FakeResponse(302);
		request.emit('response', res);
		res.finish();
		await expectRejectsWith(promise, 'Upload failed: HTTP 302');
	});

	it('rejects with a sanitized error when the request factory throws synchronously', async () => {
		const url = new URL('https://bucket.s3.amazonaws.com/some/key.epub');
		const promise = uploadToPresignedUrl(
			url,
			TEST_PAYLOAD,
			() => {
				throw new Error('factory exploded');
			},
		);
		await expectRejectsWith(promise, 'Upload failed: request error');
	});

	it('rejects with a sanitized error when setTimeout throws synchronously', async () => {
		const { promise } = makeHarness(undefined, ThrowingSetTimeoutRequest);
		await expectRejectsWith(promise, 'Upload failed: request error');
	});

	it('rejects with a sanitized error when write throws synchronously', async () => {
		const { promise } = makeHarness(undefined, ThrowingWriteRequest);
		await expectRejectsWith(promise, 'Upload failed: request error');
	});

	it('rejects with a sanitized error when end throws synchronously', async () => {
		const { promise } = makeHarness(undefined, ThrowingEndRequest);
		await expectRejectsWith(promise, 'Upload failed: request error');
	});

	it('settles as timed out even when destroy emits a synchronous error', async () => {
		const { request, promise } = makeHarness(undefined, DestroyEmitsErrorRequest);
		request.emit('timeout');
		expect(request.destroyed).toBe(true);
		await expectRejectsWith(promise, 'Upload failed: request timed out');
	});
});
