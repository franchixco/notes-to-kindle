/**
 * Validation for the presigned upload URL returned by `/GetUploadUrl`.
 *
 * The URL comes from Amazon's API but is signed S3 data, so it is still
 * treated as untrusted input: only HTTPS, only exact/subdomain Amazon hosts,
 * no userinfo, no non-default port, no IP literals, no protocol-relative
 * URLs. The query string (signature parameters) is preserved.
 */

const ALLOWED_UPLOAD_ROOT_DOMAINS = ['amazon.com', 'amazonaws.com'];

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_LITERAL_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);

function isIpLiteral(hostname: string): boolean {
	return IPV4_LITERAL_RE.test(hostname) || hostname.startsWith('[');
}

function isAllowedUploadHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return ALLOWED_UPLOAD_ROOT_DOMAINS.some(
		(domain) => host === domain || host.endsWith(`.${domain}`),
	);
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
		throw new Error(`Upload URL host "${url.hostname}" is not an allowed Amazon host`);
	}

	return url;
}
