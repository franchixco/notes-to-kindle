import { requestUrl } from 'obsidian';

import type { PkcePair } from './oauth';
import { signRequest, isoUtcNow } from './signer';

import type crypto from 'crypto';
import type fs from 'fs';

const nodeCrypto = window.require('crypto') as typeof crypto;
const nodeFs = window.require('fs') as typeof fs;

const STK_BASE = 'https://stkservice.amazon.com';
const AUTH_BASE = 'https://api.amazon.com';
const FIRS_BASE = 'https://firs-ta-g7g.amazon.com';

const CLIENT_ID =
	'658490dfb190e494030082836775981fa23be0be0c2425441860352ba0f55915b43002d';
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
	return nodeCrypto.randomBytes(20).toString('hex').toUpperCase();
}

function buildDeviceRegistrationXml(
	accessToken: string,
	deviceSerial: string,
): string {
	const entries: Array<[string, string]> = [
		['device_type', DEVICE_TYPE],
		['device_serial_number', deviceSerial],
		['pid', 'D21NN3GG'],
		['auth_token', accessToken],
		['auth_token_type', 'AccessToken'],
		['software_version', '253'],
		['os_version', 'MacOSX_10.14.6_x64'],
		['device_model', "Maxs MacBook Pro"],
	];
	const pairs = entries
		.map(
			([k, v]) =>
				`  <keyValue>\n    <key>${k}</key><value>${v}</value>\n  </keyValue>`,
		)
		.join('\n');
	return `<Map>\n${pairs}\n</Map>`;
}

// Amazon's registerDeviceWithToken returns a Map/keyValue XML document; pull
// the specific values out with a narrow regex rather than a full XML parser.
function extractXmlValue(xml: string, key: string): string {
	const match = xml.match(
		new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`),
	);
	if (!match || match[1] === undefined) {
		throw new Error(
			`Missing ${key} in device registration response`,
		);
	}
	return match[1];
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
	const response = await requestUrl({
		url: `${AUTH_BASE}/auth/token`,
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		throw: true,
	});
	const parsed = response.json as AccessTokenResponse;
	return parsed.access_token;
}

async function registerDeviceWithToken(
	accessToken: string,
): Promise<StkCredentials> {
	const deviceSerial = generateDeviceSerial();
	const xmlBody = buildDeviceRegistrationXml(accessToken, deviceSerial);

	const response = await requestUrl({
		url: `${FIRS_BASE}/FirsProxy/registerDeviceWithToken`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'User-Agent': 'Mozilla/5.0',
		},
		body: xmlBody,
		throw: true,
	});

	const xml = response.text;
	return {
		devicePrivateKeyPem: extractXmlValue(xml, 'device_private_key'),
		adpToken: extractXmlValue(xml, 'adp_token'),
		userDirectedId: extractXmlValue(xml, 'user_directed_id'),
		deviceSerialNumber: deviceSerial,
		deviceType: DEVICE_TYPE,
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
	const bodyJson = JSON.stringify(body);
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
			'User-Agent': 'Mozilla/5.0',
		},
		body: bodyJson,
		throw: true,
	});
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
	const arrayBuffer = fileBuffer.buffer.slice(
		fileBuffer.byteOffset,
		fileBuffer.byteOffset + fileBuffer.byteLength,
	);

	await requestUrl({
		url: uploadData.uploadUrl,
		method: 'PUT',
		headers: {
			'Content-Length': String(fileBuffer.length),
			'User-Agent': 'Mozilla/5.0',
		},
		body: arrayBuffer,
		throw: true,
	});

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

export function buildAmazonAuthUrl(
	pkce: PkcePair,
	redirectUri: string,
): string {
	const params = new URLSearchParams({
		'openid.oa2.client_id': `device:${CLIENT_ID}`,
		'openid.oa2.scope': 'device_auth_access',
		'openid.oa2.response_type': 'code',
		'openid.oa2.code_challenge': pkce.challenge,
		'openid.oa2.code_challenge_method': 'S256',
		'openid.return_to': redirectUri,
		'openid.assoc_handle': 'amzn_device_na',
		pageId: 'amzn_device_common_dark',
	});
	return `https://www.amazon.com/ap/signin?${params.toString()}`;
}
