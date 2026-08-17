import { describe, expect, it } from 'bun:test';
import { validateUploadUrl } from '../src/stk/upload';

describe('validateUploadUrl', () => {
	it('accepts exact S3 endpoint shapes', () => {
		for (const url of [
			'https://s3.amazonaws.com/bucket/note.epub',
			'https://s3.us-east-1.amazonaws.com/bucket/note.epub',
			'https://s3.dualstack.us-east-1.amazonaws.com/bucket/note.epub',
			'https://bucket.s3.amazonaws.com/note.epub',
			'https://bucket.s3.us-west-2.amazonaws.com/note.epub',
			'https://bucket.s3.dualstack.us-west-2.amazonaws.com/note.epub',
			'https://bucket.s3-us-west-2.amazonaws.com/note.epub',
			'https://my.bucket.s3.amazonaws.com/note.epub',
		]) {
			expect(() => validateUploadUrl(url), url).not.toThrow();
		}
	});

	it('accepts the exact Amazon CAPS upload host and preserves its opaque URL', () => {
		const url = validateUploadUrl(
			'https://zme-caps.amazon.com/opaque/upload/path?token=temporary&expires=123',
		);
		expect(url.hostname).toBe('zme-caps.amazon.com');
		expect(url.pathname).toBe('/opaque/upload/path');
		expect(url.search).toBe('?token=temporary&expires=123');
	});

	it('rejects bare Amazon roots and non-S3 Amazon subdomains', () => {
		for (const url of [
			'https://amazon.com/x.epub',
			'https://amazonaws.com/x.epub',
			'https://www.amazon.com/x',
			'https://stkservice.amazon.com/some/path',
			'https://firs-ta-g7g.amazon.com/x',
			'https://deep.sub.amazonaws.com/x',
			'https://upload.amazon.com/x',
			'https://zme-caps-us-east-1.amazon.com/x',
			'https://s3.foo.bar.amazonaws.com/x',
		]) {
			expect(() => validateUploadUrl(url), url).toThrow(/not an allowed upload endpoint/);
		}
	});

	it('rejects deceptive suffixes, unrelated hosts and third-party bucket hosts', () => {
		for (const url of [
			'https://amazon.com.evil.com/x',
			'https://amazonaws.com.evil.com/x',
			'https://evilamazonaws.com/x',
			'https://amazon.com.co/x',
			'https://www.amazon.co.uk/x',
			'https://evil.com/x',
			'https://cloudfront.net/x',
			'https://amazon.com.attacker.io/x',
			'https://s3.amazonaws.com.evil.com/x',
			'https://bucket.s3.example.com/x',
			'https://bucket.storage.example.com/x',
			'https://s3.notamazon.com/x',
			'https://my-bucket.s3.dualstack.evil.io/x',
			'https://evil.zme-caps.amazon.com/x',
			'https://zme-caps.amazon.com.evil.test/x',
			'https://zme-caps-amazon.com/x',
		]) {
			expect(() => validateUploadUrl(url), url).toThrow(/not an allowed upload endpoint/);
		}
	});

	it('preserves the query string on the returned URL', () => {
		const url = validateUploadUrl(
			'https://s3.amazonaws.com/bucket/note.epub?X-Amz-Signature=abc&part=1',
		);
		expect(url.search).toBe('?X-Amz-Signature=abc&part=1');
		expect(url.pathname).toBe('/bucket/note.epub');
		expect(url.protocol).toBe('https:');
	});

	it('rejects non-HTTPS schemes', () => {
		for (const url of [
			'http://s3.amazonaws.com/x',
			'ftp://amazon.com/x',
			'file://amazon.com/x',
			'javascript:alert(1)',
		]) {
			expect(() => validateUploadUrl(url), url).toThrow(/HTTPS/);
		}
	});

	it('rejects userinfo', () => {
		expect(() => validateUploadUrl('https://user:pass@s3.amazonaws.com/x')).toThrow(
			/userinfo/,
		);
	});

	it('rejects non-default ports', () => {
		for (const url of [
			'https://s3.amazonaws.com:8443/x',
			'https://bucket.s3.amazonaws.com:8080/x',
			'https://amazon.com:8080/x',
			'https://zme-caps.amazon.com:8443/x',
		]) {
			expect(() => validateUploadUrl(url), url).toThrow(/non-default port/);
		}
	});

	it('rejects IP literals', () => {
		for (const url of [
			'https://1.2.3.4/x',
			'https://127.0.0.1/x',
			'https://[::1]/x',
			'https://0x7f000001/x',
		]) {
			expect(() => validateUploadUrl(url), url).toThrow(/IP address/);
		}
	});

	it('rejects protocol-relative URLs', () => {
		expect(() => validateUploadUrl('//s3.amazonaws.com/x')).toThrow(/protocol-relative/);
	});

	it('rejects malformed and empty input', () => {
		expect(() => validateUploadUrl('')).toThrow(/empty/);
		expect(() => validateUploadUrl('not a url')).toThrow(/malformed/);
		expect(() => validateUploadUrl('https://')).toThrow(/malformed/);
	});
});
