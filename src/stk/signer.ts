import type crypto from 'crypto';

const nodeCrypto = window.require('crypto') as typeof crypto;

type RsaPrivateJwk = {
	kty?: string;
	n?: string;
	d?: string;
};

function base64urlToBuffer(value: string): Buffer {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Buffer.from(padded, 'base64');
}

function bufferToBigInt(buf: Buffer): bigint {
	const hex = buf.toString('hex');
	return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

function bigIntToBuffer(value: bigint, size: number): Buffer {
	const hex = value.toString(16).padStart(size * 2, '0');
	return Buffer.from(hex, 'hex');
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
	let result = 1n;
	let current = base % modulus;
	let exp = exponent;
	while (exp > 0n) {
		if ((exp & 1n) === 1n) result = (result * current) % modulus;
		current = (current * current) % modulus;
		exp >>= 1n;
	}
	return result;
}

function buildPkcs1Payload(digest: Buffer, keyBytes: number): Buffer {
	const payloadBytes = keyBytes - 1;
	const padLength = payloadBytes - digest.length;
	if (padLength < 3) {
		throw new Error('Private key too small for STK signing payload');
	}

	const payload = Buffer.alloc(payloadBytes, 0xff);
	payload[0] = 0x01;
	payload[padLength - 1] = 0x00;
	digest.copy(payload, padLength);
	return payload;
}

/**
 * Amazon STK does not use a normal RSA-SHA256 signature here. It hashes the
 * canonical request body with SHA-256, wraps that digest in a manually padded
 * PKCS#1 v1.5 block, and then applies raw RSA private-key encryption.
 */
export function signRequest(
	privateKeyPem: string,
	adpToken: string,
	method: string,
	path: string,
	signingDate: string,
	postData: string,
): string {
	const sigData = Buffer.from(
		[method, path, signingDate, postData, adpToken].join('\n'),
		'utf8',
	);
	const digest = nodeCrypto.createHash('sha256').update(sigData).digest();
	const privateKey = nodeCrypto.createPrivateKey(privateKeyPem);
	const jwk = privateKey.export({ format: 'jwk' }) as RsaPrivateJwk;
	if (jwk.kty !== 'RSA' || !jwk.n || !jwk.d) {
		throw new Error('Could not extract RSA private key parameters for STK signing');
	}
	const modulus = bufferToBigInt(base64urlToBuffer(jwk.n));
	const privateExponent = bufferToBigInt(base64urlToBuffer(jwk.d));
	const keyBytes = base64urlToBuffer(jwk.n).length;
	const payload = buildPkcs1Payload(digest, keyBytes);
	const payloadInt = bufferToBigInt(payload);
	const encryptedInt = modPow(payloadInt, privateExponent, modulus);
	const encrypted = bigIntToBuffer(encryptedInt, keyBytes);
	return `${encrypted.toString('base64')}:${signingDate}`;
}

export function isoUtcNow(): string {
	return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}
