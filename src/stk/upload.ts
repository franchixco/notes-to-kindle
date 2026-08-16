/**
 * Validation for the presigned upload URL returned by `/GetUploadUrl`.
 *
 * The URL comes from Amazon's API but is signed S3 data, so it is still
 * treated as untrusted input: only HTTPS, only exact AWS S3 endpoint host
 * shapes, no userinfo, no non-default port, no IP literals, no
 * protocol-relative URLs. The query string (signature parameters) is
 * preserved.
 */

const REGION_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const BUCKET_LABEL = '[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?';

// Exact S3 endpoint host forms (lowercased, full-string match):
//   s3.amazonaws.com
//   s3.<region>.amazonaws.com
//   s3.dualstack.<region>.amazonaws.com
//   <bucket>.s3.amazonaws.com
//   <bucket>.s3.<region>.amazonaws.com
//   <bucket>.s3.dualstack.<region>.amazonaws.com
//   <bucket>.s3-<region>.amazonaws.com (legacy)
const S3_HOST_PATTERNS = [
	new RegExp(`^s3\\.amazonaws\\.com$`),
	new RegExp(`^s3\\.${REGION_LABEL}\\.amazonaws\\.com$`),
	new RegExp(`^s3\\.dualstack\\.${REGION_LABEL}\\.amazonaws\\.com$`),
	new RegExp(`^${BUCKET_LABEL}\\.s3\\.amazonaws\\.com$`),
	new RegExp(`^${BUCKET_LABEL}\\.s3\\.${REGION_LABEL}\\.amazonaws\\.com$`),
	new RegExp(`^${BUCKET_LABEL}\\.s3\\.dualstack\\.${REGION_LABEL}\\.amazonaws\\.com$`),
	new RegExp(`^${BUCKET_LABEL}\\.s3-${REGION_LABEL}\\.amazonaws\\.com$`),
];

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_LITERAL_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

function isIpLiteral(hostname: string): boolean {
	return IPV4_LITERAL_RE.test(hostname) || hostname.startsWith('[');
}

function isS3EndpointHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return S3_HOST_PATTERNS.some((pattern) => pattern.test(host));
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
	if (!isS3EndpointHost(url.hostname)) {
		throw new Error(`Upload URL host "${url.hostname}" is not an allowed S3 endpoint`);
	}

	return url;
}
