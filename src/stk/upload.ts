/**
 * Validation for the presigned upload URL returned by `/GetUploadUrl`.
 *
 * The URL comes from Amazon's API but is still treated as untrusted input:
 * only HTTPS, only exact AWS S3 endpoint host shapes or Amazon's exact CAPS
 * upload host, no userinfo, no non-default port, no IP literals, no
 * protocol-relative URLs. The query string (signature parameters) is preserved.
 */

// Exact S3 endpoint host forms (lowercased, full-string match):
//   s3.amazonaws.com
//   s3.<region>.amazonaws.com
//   s3.dualstack.<region>.amazonaws.com
//   <bucket>.s3.amazonaws.com
//   <bucket>.s3.<region>.amazonaws.com
//   <bucket>.s3.dualstack.<region>.amazonaws.com
//   <bucket>.s3-<region>.amazonaws.com (legacy)
const S3_HOST_PATTERNS = [
	/^s3\.amazonaws\.com$/,
	/^s3\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.amazonaws\.com$/,
	/^s3\.dualstack\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.amazonaws\.com$/,
	/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\.s3\.amazonaws\.com$/,
	/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\.s3\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.amazonaws\.com$/,
	/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\.s3\.dualstack\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.amazonaws\.com$/,
	/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\.s3-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.amazonaws\.com$/,
];

// Current STK responses can use Amazon's Content Acquisition and Processing
// Service instead of S3 directly. Keep this exact: no amazon.com wildcard and
// no certificate alias is trusted unless GetUploadUrl starts returning it.
const CAPS_UPLOAD_HOST = 'zme-caps.amazon.com';

const IPV4_LITERAL_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpLiteral(hostname: string): boolean {
	return IPV4_LITERAL_RE.test(hostname) || hostname.startsWith('[');
}

function isAllowedUploadHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === CAPS_UPLOAD_HOST || S3_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

export function validateUploadUrl(rawUrl: string): URL {
	if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
		throw new Error('Upload URL is empty');
	}
	const trimmed = rawUrl.trim();
	if (trimmed.startsWith('//')) {
		throw new Error('Upload URL must be absolute HTTPS (protocol-relative URLs are rejected)');
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error('Upload URL is malformed');
	}

	if (url.protocol !== 'https:') {
		throw new Error('Upload URL must use HTTPS');
	}
	if (url.port !== '') {
		throw new Error('Upload URL must not specify a non-default port');
	}
	if (url.username !== '' || url.password !== '') {
		throw new Error('Upload URL must not contain userinfo');
	}
	if (isIpLiteral(url.hostname)) {
		throw new Error('Upload URL must use a hostname, not an IP address');
	}
	if (!isAllowedUploadHost(url.hostname)) {
		throw new Error(`Upload URL host "${url.hostname}" is not an allowed upload endpoint`);
	}

	return url;
}
