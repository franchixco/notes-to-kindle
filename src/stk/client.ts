import { requestUrl } from 'obsidian';

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

export async function registerDevice(
	authorizationCode: string,
	codeVerifier: string,
): Promise<StkCredentials> {
	throw new Error('not implemented');
}

export async function listOwnedDevices(
	creds: StkCredentials,
): Promise<OwnedDevice[]> {
	throw new Error('not implemented');
}

export interface SendOptions {
	filePath: string;
	title: string;
	author: string;
	format: 'EPUB' | 'PDF';
	targetSerials: string[];
}

export async function sendToKindle(
	creds: StkCredentials,
	opts: SendOptions,
): Promise<void> {
	throw new Error('not implemented');
}
