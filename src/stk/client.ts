import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';

import type { PkcePair } from './oauth';
import { signRequest, isoUtcNow } from './signer';

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

const DEFAULT_CLIENT_INFO = {
	appName: 'ShellExtension',
	appVersion: '1.1.1.253',
	os: 'MacOSX_10.14.6_x64',
	osArchitecture: 'x64',
};

export interface StkCredentials {
	devicePrivateKeyPem: string;
	adpToken: string;
	userDirectedId: string;
	deviceSerialNumber: string;
	deviceType: string;
	accountName: string | null;
	registeredDeviceName: string | null;
}

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
}

interface AccessTokenResponse {
	access_token: string;
}

interface GetOwnedDevicesResponse {
	ownedDevices: Array<{ deviceSerialNumber: string; deviceName: string }>;
}

interface GetUploadUrlResponse {
	uploadUrl: string;
	stkToken: string;
}

function uploadFileToPresignedUrl(url: string, fileBuffer: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const req = nodeHttps.request(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				method: 'PUT',
				headers: {
					'Content-Length': String(fileBuffer.length),
					'Accept-Encoding': 'gzip, deflate',
					'Accept-Language': 'en-US,*',
					'User-Agent': 'Mozilla/5.0',
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer | string) => {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				});
				res.on('end', () => {
					if (res.statusCode === 200) {
						resolve();
						return;
					}
					const body = Buffer.concat(chunks).toString('utf8').trim().replace(/\s+/g, ' ').slice(0, 400);
					reject(new Error(body.length > 0 ? `Upload failed: HTTP ${res.statusCode} | ${body}` : `Upload failed: HTTP ${res.statusCode}`));
				});
			},
		);
		req.on('error', reject);
		req.write(fileBuffer);
		req.end();
	});
}

function describeRequestError(err: unknown): string {
	const toText = (value: unknown): string => {
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	};

	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	if (err && typeof err === 'object') {
		const maybe = err as {
			status?: unknown;
			statusCode?: unknown;
			message?: unknown;
			body?: unknown;
		};
		const parts = [maybe.message, maybe.status, maybe.statusCode, maybe.body]
			.filter((value) => value !== undefined && value !== null)
			.map((value) => toText(value));
		if (parts.length > 0) return parts.join(' | ');
	}
	return toText(err);
}

function summarizeResponse(response: RequestUrlResponse): string {
	const body = response.text.trim().replace(/\s+/g, ' ').slice(0, 400);
	return body.length > 0 ? `HTTP ${response.status} | ${body}` : `HTTP ${response.status}`;
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
				'User-Agent': 'Mozilla/5.0',
			},
			body: JSON.stringify(body),
			throw: false,
		});
	} catch (err) {
		throw new Error(`Token exchange failed: ${describeRequestError(err)}`);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Token exchange failed: ${summarizeResponse(response)}`);
	}
	const parsed = response.json as AccessTokenResponse;
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
				'User-Agent': 'Mozilla/5.0',
			},
			body: xmlBody,
			throw: false,
		});
	} catch (err) {
		throw new Error(`Register device failed: ${describeRequestError(err)}`);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Register device failed: ${summarizeResponse(response)}`);
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

async function signedPost<T>(
	creds: StkCredentials,
	path: string,
	body: unknown,
): Promise<T> {
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
	const response = await requestUrl({
		url: `${STK_BASE}${path}`,
		method: 'POST',
		headers: {
			'X-ADP-Request-Digest': digest,
			'X-ADP-Authentication-Token': creds.adpToken,
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'Accept-Encoding': 'gzip, deflate',
			'Accept-Language': 'en-US,*',
			'User-Agent': 'Mozilla/5.0',
		},
		body: bodyJson,
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`${path} failed: ${summarizeResponse(response)}`);
	}
	return response.json as T;
}

export async function listOwnedDevices(
	creds: StkCredentials,
): Promise<OwnedDevice[]> {
	const parsed = await signedPost<GetOwnedDevicesResponse>(
		creds,
		'/GetListOfOwnedDevices',
		{ ClientInfo: DEFAULT_CLIENT_INFO },
	);
	return parsed.ownedDevices.map((d) => ({
		serialNumber: d.deviceSerialNumber,
		deviceName: d.deviceName,
	}));
}

export async function sendToKindle(
	creds: StkCredentials,
	opts: SendOptions,
): Promise<void> {
	const stats = nodeFs.statSync(opts.filePath);
	const fileSize = stats.size;

	const uploadData = await signedPost<GetUploadUrlResponse>(
		creds,
		'/GetUploadUrl',
		{ ClientInfo: DEFAULT_CLIENT_INFO, fileSize },
	);

	const fileBuffer = nodeFs.readFileSync(opts.filePath);

	await uploadFileToPresignedUrl(uploadData.uploadUrl, fileBuffer);

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

	await signedPost<unknown>(creds, '/SendToKindle', sendBody);
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

export function parseAuthorizationCode(redirectUrl: string): string {
	const u = new URL(redirectUrl);
	const code = u.searchParams.get('openid.oa2.authorization_code');
	if (!code) throw new Error('No authorization_code in URL');
	return code;
}
