/**
 * Storage and validation of Send to Kindle credentials.
 *
 * Credentials are kept in the OS keychain through Obsidian's SecretStorage.
 * The secret key is namespaced (`send-to-kindle-credentials`); credentials
 * written before that rename lived under the legacy `stk-credentials` key and
 * are migrated once, then the legacy key is blanked.
 *
 * Disconnecting only clears the local secret — it does not revoke anything on
 * Amazon's side. The user is told how to remove the synthetic device in their
 * Amazon account settings separately.
 */

export const CREDENTIALS_KEY = 'send-to-kindle-credentials';
export const LEGACY_CREDENTIALS_KEY = 'stk-credentials';

export interface StkCredentials {
	devicePrivateKeyPem: string;
	adpToken: string;
	userDirectedId: string;
	deviceSerialNumber: string;
	deviceType: string;
	accountName: string | null;
	registeredDeviceName: string | null;
}

const REQUIRED_CREDENTIAL_FIELDS = [
	'devicePrivateKeyPem',
	'adpToken',
	'userDirectedId',
	'deviceSerialNumber',
	'deviceType',
] as const;

const OPTIONAL_CREDENTIAL_FIELDS = ['accountName', 'registeredDeviceName'] as const;

/** Synchronous subset of Obsidian's `SecretStorage`, injectable in tests. */
export interface SecretStore {
	getSecret(key: string): string | null;
	setSecret(key: string, value: string): void;
}

export function validateCredentials(value: unknown): StkCredentials {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Stored credentials must be an object');
	}
	const record = value as Record<string, unknown>;

	const creds: StkCredentials = {
		devicePrivateKeyPem: '',
		adpToken: '',
		userDirectedId: '',
		deviceSerialNumber: '',
		deviceType: '',
		accountName: null,
		registeredDeviceName: null,
	};

	for (const field of REQUIRED_CREDENTIAL_FIELDS) {
		const fieldValue = record[field];
		if (typeof fieldValue !== 'string' || fieldValue.length === 0) {
			throw new Error(`Stored credentials missing required string field "${field}"`);
		}
		creds[field] = fieldValue;
	}

	for (const field of OPTIONAL_CREDENTIAL_FIELDS) {
		const fieldValue = record[field];
		if (fieldValue === undefined || fieldValue === null) {
			creds[field] = null;
		} else if (typeof fieldValue === 'string') {
			creds[field] = fieldValue;
		} else {
			throw new Error(`Stored credentials field "${field}" must be a string or null`);
		}
	}

	return creds;
}

export function readCredentials(store: SecretStore): StkCredentials | null {
	const raw = store.getSecret(CREDENTIALS_KEY);
	if (raw === null || raw.length === 0) return null;
	try {
		return validateCredentials(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

export function writeCredentials(store: SecretStore, creds: StkCredentials): void {
	store.setSecret(CREDENTIALS_KEY, JSON.stringify(validateCredentials(creds)));
}

/**
 * Migrates a valid legacy secret into the namespaced key and blanks the legacy
 * key. Returns true when a migration happened. A valid secret under the new
 * key wins; a corrupt new-key value is recovered from a valid legacy secret.
 */
export function migrateLegacyCredentials(store: SecretStore): boolean {
	const currentRaw = store.getSecret(CREDENTIALS_KEY);
	if (currentRaw !== null && currentRaw.length > 0) {
		try {
			validateCredentials(JSON.parse(currentRaw) as unknown);
			return false;
		} catch {
			// Corrupt current key — recover from a valid legacy secret below.
		}
	}

	const legacyRaw = store.getSecret(LEGACY_CREDENTIALS_KEY);
	if (legacyRaw === null || legacyRaw.length === 0) return false;

	let legacy: unknown;
	try {
		legacy = JSON.parse(legacyRaw) as unknown;
	} catch {
		return false;
	}

	let creds: StkCredentials;
	try {
		creds = validateCredentials(legacy);
	} catch {
		return false;
	}

	store.setSecret(CREDENTIALS_KEY, JSON.stringify(creds));
	store.setSecret(LEGACY_CREDENTIALS_KEY, '');
	return true;
}

/**
 * Clears credentials from this device. Local only — does not claim any
 * server-side revocation on Amazon's side.
 */
export function disconnectCredentials(store: SecretStore): void {
	store.setSecret(CREDENTIALS_KEY, '');
	store.setSecret(LEGACY_CREDENTIALS_KEY, '');
}
