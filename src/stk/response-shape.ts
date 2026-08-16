/**
 * Shape validation for the high-level JSON responses parsed from Amazon's STK
 * API. Run before any field is dereferenced so a malformed or hostile body is
 * rejected with a fixed sanitized error that never embeds the remote payload.
 */

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OwnedDeviceShape {
	serialNumber: string;
	deviceName: string;
}

export function parseOwnedDevicesResponse(value: unknown): OwnedDeviceShape[] {
	if (!isRecord(value) || !Array.isArray(value.ownedDevices)) {
		throw new Error('Invalid owned devices response');
	}
	return value.ownedDevices.map((entry) => {
		if (
			!isRecord(entry)
			|| !isNonEmptyString(entry.deviceSerialNumber)
			|| !isNonEmptyString(entry.deviceName)
		) {
			throw new Error('Invalid owned devices response');
		}
		return { serialNumber: entry.deviceSerialNumber, deviceName: entry.deviceName };
	});
}

export interface UploadUrlShape {
	uploadUrl: string;
	stkToken: string;
}

export function parseUploadUrlResponse(value: unknown): UploadUrlShape {
	if (
		!isRecord(value)
		|| !isNonEmptyString(value.uploadUrl)
		|| !isNonEmptyString(value.stkToken)
	) {
		throw new Error('Invalid upload URL response');
	}
	return { uploadUrl: value.uploadUrl, stkToken: value.stkToken };
}
