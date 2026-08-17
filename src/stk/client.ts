import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';

import type { PkcePair } from './oauth';
import { signRequest, isoUtcNow } from './signer';
import type { StkCredentials } from './credentials';
export type { StkCredentials } from './credentials';
import { validateUploadUrl } from './upload';
import { uploadToPresignedUrl } from './presign-upload';
import type { UploadRequestFactory } from './presign-upload';
import { parseOwnedDevicesResponse, parseUploadUrlResponse } from './response-shape';
import { STK_USER_AGENT } from './user-agent';

import type crypto from 'crypto';
import type fs from 'fs';
import type https from 'https';

const nodeCrypto = window.require('crypto') as typeof crypto;
const nodeFs = window.require('fs') as typeof fs;
const nodeHttps = window.require('https') as typeof https;

const STK_BASE = 'https://stkservice.amazon.com';
const AUTH_BASE = 'https://api.amazon.com';
const FIRS_BASE = 'https://firs-ta-g7g.amazon.com';

const CLIENT_ID =
	'658490dfb190e494030082836775981fa23be0c2425441860352ba0f55915b43002d';
const DEVICE_TYPE = 'A1K6D1WRW0MALS';

// The protocol-required `ShellExtension` identity is preserved in the signed
// request body (ClientInfo); the User-Agent header is transparent instead.
const DEFAULT_CLIENT_INFO = {
	appName: 'ShellExtension',
	appVersion: '1.1.1.253',
	os: 'MacOSX_10.14.6_x64',
	osArchitecture: 'x64',
};

export interface OwnedDevice {
	serialNumber: string;
	deviceName: string;
}

export interface SendOptions {
	filePath: string;
	title: string;
	author: string;
	format: 'EPUB' | 'PDF';
	targetSerials: string[];
	signal?: AbortSignal;
}

interface AccessTokenResponse {
	access_token: string;
}

function uploadFileToPresignedUrl(url: string, fileBuffer: Buffer, signal?: AbortSignal): Promise<void> {
	const target = validateUploadUrl(url);
	const requestFactory: UploadRequestFactory = (options) => nodeHttps.request(options);
	return uploadToPresignedUrl(target, fileBuffer, requestFactory, { signal });
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException('Send cancelled.', 'AbortError');
}

// Remote response bodies must never reach thrown errors or logs. A remote
// failure is reported as operation + HTTP status; transport failures are
// reported with a fixed sanitized category.
function statusError(operation: string, status: number): Error {
	return new Error(`${operation} failed: HTTP ${status}`);
}

function transportError(operation: string): Error {
	return new Error(`${operation} failed: request error`);
}

function invalidResponseBodyError(operation: string): Error {
	return new Error(`${operation} failed: invalid response body`);
}

interface SendToKindleRequestBody {
	ClientInfo: typeof DEFAULT_CLIENT_INFO;
	DocumentMetadata: {
		author: string;
		crc32: number;
		inputFormat: 'EPUB' | 'PDF';
		title: string;
	};
	archive: boolean;
	deliveryMechanism: 'WIFI';
	outputFormat: 'MOBI';
	stkToken: string;
	targetDevices: string[];
}

function generateDeviceSerial(): string {
	return nodeCrypto.randomBytes(16).toString('hex').toUpperCase();
}

function buildDeviceRegistrationXml(
	accessToken: string,
	deviceSerial: string,
): string {
	return `<?xml version='1.0' encoding='UTF-8'?>
<request><parameters><deviceType>${DEVICE_TYPE}</deviceType><deviceSerialNumber>${deviceSerial}</deviceSerialNumber><pid>D21NN3GG</pid><authToken>${accessToken}</authToken><authTokenType>AccessToken</authTokenType><softwareVersion>253</softwareVersion><os_version>MacOSX_10.14.6_x64</os_version><device_model>Maxs MacBook Pro</device_model></parameters></request>`;
}

function parseXmlResponse(xml: string): Document {
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	const parserError = doc.querySelector('parsererror');
	if (parserError) {
		throw new Error('Invalid XML in device registration response');
	}
	return doc;
}

function extractXmlValue(doc: Document, key: string): string {
	const value = doc.querySelector(key)?.textContent?.trim();
	if (!value) {
		throw new Error(`Missing ${key} in device registration response`);
	}
	return value;
}

function extractOptionalXmlValue(doc: Document, key: string): string | null {
	return doc.querySelector(key)?.textContent?.trim() || null;
}

async function exchangeCodeForAccessToken(
	authorizationCode: string,
	codeVerifier: string,
): Promise<string> {
	const body = {
		app_name: 'Unknown',
		client_domain: 'DeviceLegacy',
		client_id: CLIENT_ID,
		code_algorithm: 'SHA-256',
		code_verifier: codeVerifier,
		requested_token_type: 'access_token',
		source_token: authorizationCode,
		source_token_type: 'authorization_code',
	};
	let response: RequestUrlResponse;
	try {
		response = await requestUrl({
			url: `${AUTH_BASE}/auth/token`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept-Language': 'en-US',
				'x-amzn-identity-auth-domain': 'api.amazon.com',
				'User-Agent': STK_USER_AGENT,
			},
			body: JSON.stringify(body),
			throw: false,
		});
	} catch {
		throw transportError('Token exchange');
	}
	if (response.status < 200 || response.status >= 300) {
		throw statusError('Token exchange', response.status);
	}
	let parsed: AccessTokenResponse;
	try {
		parsed = response.json as AccessTokenResponse;
	} catch {
		throw invalidResponseBodyError('Token exchange');
	}
	if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
		throw invalidResponseBodyError('Token exchange');
	}
	return parsed.access_token;
}

async function registerDeviceWithToken(
	accessToken: string,
): Promise<StkCredentials> {
	const deviceSerial = generateDeviceSerial();
	const xmlBody = buildDeviceRegistrationXml(accessToken, deviceSerial);

	let response: RequestUrlResponse;
	try {
		response = await requestUrl({
			url: `${FIRS_BASE}/FirsProxy/registerDeviceWithToken`,
			method: 'POST',
			headers: {
				'Content-Type': 'text/xml',
				Expect: '',
				'Accept-Language': 'en-US,*',
				'User-Agent': STK_USER_AGENT,
			},
			body: xmlBody,
			throw: false,
		});
	} catch {
		throw transportError('Register device');
	}
	if (response.status < 200 || response.status >= 300) {
		throw statusError('Register device', response.status);
	}

	const xml = response.text;
	const doc = parseXmlResponse(xml);
	return {
		devicePrivateKeyPem: extractXmlValue(doc, 'device_private_key'),
		adpToken: extractXmlValue(doc, 'adp_token'),
		userDirectedId: extractXmlValue(doc, 'user_directed_id'),
		deviceSerialNumber: deviceSerial,
		deviceType: DEVICE_TYPE,
		accountName: extractOptionalXmlValue(doc, 'name'),
		registeredDeviceName: extractOptionalXmlValue(doc, 'user_device_name'),
	};
}

export async function registerDevice(
	authorizationCode: string,
	codeVerifier: string,
): Promise<StkCredentials> {
	const accessToken = await exchangeCodeForAccessToken(
		authorizationCode,
		codeVerifier,
	);
	return registerDeviceWithToken(accessToken);
}

async function signedPost(
	creds: StkCredentials,
	path: string,
	body: unknown,
): Promise<unknown> {
	const bodyJson = JSON.stringify(body, null, 4);
	const signingDate = isoUtcNow();
	const digest = signRequest(
		creds.devicePrivateKeyPem,
		creds.adpToken,
		'POST',
		path,
		signingDate,
		bodyJson,
	);
	let response: RequestUrlResponse;
	try {
		response = await requestUrl({
			url: `${STK_BASE}${path}`,
			method: 'POST',
			headers: {
				'X-ADP-Request-Digest': digest,
				'X-ADP-Authentication-Token': creds.adpToken,
				'Content-Type': 'application/json',
				Accept: 'application/json',
				'Accept-Encoding': 'gzip, deflate',
				'Accept-Language': 'en-US,*',
				'User-Agent': STK_USER_AGENT,
			},
			body: bodyJson,
			throw: false,
		});
	} catch {
		throw transportError(path);
	}
	if (response.status < 200 || response.status >= 300) {
		throw statusError(path, response.status);
	}
	try {
		return response.json as unknown;
	} catch {
		throw invalidResponseBodyError(path);
	}
}

export async function listOwnedDevices(
	creds: StkCredentials,
): Promise<OwnedDevice[]> {
	const parsed = await signedPost(
		creds,
		'/GetListOfOwnedDevices',
		{ ClientInfo: DEFAULT_CLIENT_INFO },
	);
	return parseOwnedDevicesResponse(parsed);
}

export async function sendToKindle(
	creds: StkCredentials,
	opts: SendOptions,
): Promise<void> {
	throwIfCancelled(opts.signal);
	const stats = nodeFs.statSync(opts.filePath);
	const fileSize = stats.size;

	const uploadResponse = await signedPost(
		creds,
		'/GetUploadUrl',
		{ ClientInfo: DEFAULT_CLIENT_INFO, fileSize },
	);
	throwIfCancelled(opts.signal);
	const uploadData = parseUploadUrlResponse(uploadResponse);

	const fileBuffer = nodeFs.readFileSync(opts.filePath);
	throwIfCancelled(opts.signal);

	await uploadFileToPresignedUrl(uploadData.uploadUrl, fileBuffer, opts.signal);
	throwIfCancelled(opts.signal);

	const sendBody: SendToKindleRequestBody = {
		ClientInfo: DEFAULT_CLIENT_INFO,
		DocumentMetadata: {
			author: opts.author,
			crc32: 0,
			inputFormat: opts.format,
			title: opts.title,
		},
		archive: true,
		deliveryMechanism: 'WIFI',
		outputFormat: 'MOBI',
		stkToken: uploadData.stkToken,
		targetDevices: opts.targetSerials,
	};

	throwIfCancelled(opts.signal);
	await signedPost(creds, '/SendToKindle', sendBody);
	throwIfCancelled(opts.signal);
}

export function buildAmazonAuthUrl(pkce: PkcePair): string {
	const params = new URLSearchParams({
		'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
		'openid.ns.oa2': 'http://www.amazon.com/ap/ext/oauth/2',
		'openid.ns': 'http://specs.openid.net/auth/2.0',
		'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
		'openid.oa2.client_id': `device:${CLIENT_ID}`,
		'openid.mode': 'checkid_setup',
		'openid.oa2.scope': 'device_auth_access',
		'openid.oa2.response_type': 'code',
		'openid.oa2.code_challenge': pkce.challenge,
		'openid.oa2.code_challenge_method': 'S256',
		'openid.return_to': 'https://www.amazon.com/gp/sendtokindle',
		'openid.ns.pape': 'http://specs.openid.net/extensions/pape/1.0',
		'openid.pape.max_auth_age': '0',
		accountStatusPolicy: 'P1',
		'openid.assoc_handle': 'amzn_device_na',
		pageId: 'amzn_device_common_dark',
		disableLoginPrepopulate: '1',
	});
	return `https://www.amazon.com/ap/signin?${params.toString()}`;
}
