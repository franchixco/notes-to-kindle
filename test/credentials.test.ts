import { describe, expect, it } from 'bun:test';
import {
	CREDENTIALS_KEY,
	disconnectCredentials,
	LEGACY_CREDENTIALS_KEY,
	migrateLegacyCredentials,
	readCredentials,
	validateCredentials,
	writeCredentials,
	type SecretStore,
	type StkCredentials,
} from '../src/stk/credentials';

function fakeStore(initial: Record<string, string> = {}): SecretStore {
	const map = new Map(Object.entries(initial));
	return {
		getSecret: (key: string) => map.get(key) ?? null,
		setSecret: (key: string, value: string) => {
			map.set(key, value);
		},
	};
}

function validCreds(overrides: Partial<StkCredentials> = {}): StkCredentials {
	return {
		devicePrivateKeyPem: 'device-private-key-material',
		adpToken: 'adp-token-value',
		userDirectedId: 'user-directed-id',
		deviceSerialNumber: 'ABCDEF0123456789',
		deviceType: 'A1K6D1WRW0MALS',
		accountName: null,
		registeredDeviceName: null,
		...overrides,
	};
}

describe('validateCredentials', () => {
	it('accepts a well-formed credentials object', () => {
		const creds = validCreds({ accountName: 'acct', registeredDeviceName: 'dev' });
		expect(validateCredentials(creds)).toEqual(creds);
	});

	it('rejects non-objects', () => {
		for (const value of [null, undefined, 'x', 42, ['a'], true]) {
			expect(() => validateCredentials(value)).toThrow();
		}
	});

	it('rejects missing required fields', () => {
		const rest: Partial<StkCredentials> = { ...validCreds() };
		delete rest.devicePrivateKeyPem;
		expect(() => validateCredentials(rest)).toThrow(/devicePrivateKeyPem/);
	});

	it('rejects non-string and empty required fields', () => {
		const bad = validCreds();
		(bad as unknown as Record<string, unknown>).adpToken = '';
		expect(() => validateCredentials(bad)).toThrow(/adpToken/);
		(bad as unknown as Record<string, unknown>).adpToken = 123;
		expect(() => validateCredentials(bad)).toThrow(/adpToken/);
	});

	it('accepts null optional fields and rejects other types', () => {
		const ok = validCreds();
		ok.accountName = 'some name';
		ok.registeredDeviceName = 'Kindle';
		expect(validateCredentials(ok).accountName).toBe('some name');

		const bad = validCreds();
		(bad as unknown as Record<string, unknown>).accountName = 42;
		expect(() => validateCredentials(bad)).toThrow(/accountName/);
	});

	it('normalizes absent optional fields to null', () => {
		const parsed = validateCredentials(JSON.parse(JSON.stringify(validCreds())));
		expect(parsed.accountName).toBeNull();
		expect(parsed.registeredDeviceName).toBeNull();
	});
});

describe('readCredentials / writeCredentials', () => {
	it('returns null when no secret is stored', () => {
		expect(readCredentials(fakeStore())).toBeNull();
	});

	it('round-trips a valid credential payload', () => {
		const store = fakeStore();
		const creds = validCreds({ accountName: 'acct' });
		writeCredentials(store, creds);
		expect(readCredentials(store)).toEqual(creds);
	});

	it('treats an empty stored secret as absent', () => {
		const store = fakeStore({ [CREDENTIALS_KEY]: '' });
		expect(readCredentials(store)).toBeNull();
	});

	it('returns null for corrupt or invalid stored payloads', () => {
		for (const raw of ['not json', '{"adpToken":"only"}', '{"a":1}']) {
			const store = fakeStore({ [CREDENTIALS_KEY]: raw });
			expect(readCredentials(store), raw).toBeNull();
		}
	});

	it('rejects invalid credentials on write', () => {
		const store = fakeStore();
		const bad = validCreds();
		(bad as unknown as Record<string, unknown>).userDirectedId = '';
		expect(() => writeCredentials(store, bad)).toThrow(/userDirectedId/);
		expect(store.getSecret(CREDENTIALS_KEY)).toBeNull();
	});
});

describe('migrateLegacyCredentials', () => {
	it('does nothing when there is no legacy secret', () => {
		const store = fakeStore();
		expect(migrateLegacyCredentials(store)).toBe(false);
	});

	it('migrates a valid legacy secret and blanks the legacy key', () => {
		const store = fakeStore({ [LEGACY_CREDENTIALS_KEY]: JSON.stringify(validCreds()) });
		expect(migrateLegacyCredentials(store)).toBe(true);
		expect(readCredentials(store)).toEqual(validCreds());
		expect(store.getSecret(LEGACY_CREDENTIALS_KEY)).toBe('');
	});

	it('keeps a valid current secret and does not migrate', () => {
		const store = fakeStore({
			[CREDENTIALS_KEY]: JSON.stringify(validCreds({ accountName: 'new' })),
			[LEGACY_CREDENTIALS_KEY]: JSON.stringify(validCreds({ accountName: 'legacy' })),
		});
		expect(migrateLegacyCredentials(store)).toBe(false);
		expect(readCredentials(store)?.accountName).toBe('new');
		expect(store.getSecret(LEGACY_CREDENTIALS_KEY)).not.toBe('');
	});

	it('recovers a corrupt current secret from a valid legacy secret', () => {
		const store = fakeStore({
			[CREDENTIALS_KEY]: 'corrupt',
			[LEGACY_CREDENTIALS_KEY]: JSON.stringify(validCreds()),
		});
		expect(migrateLegacyCredentials(store)).toBe(true);
		expect(readCredentials(store)).toEqual(validCreds());
		expect(store.getSecret(LEGACY_CREDENTIALS_KEY)).toBe('');
	});

	it('ignores invalid legacy payloads', () => {
		for (const legacyRaw of ['not json', JSON.stringify({ adpToken: 'only' })]) {
			const store = fakeStore({ [LEGACY_CREDENTIALS_KEY]: legacyRaw });
			expect(migrateLegacyCredentials(store), legacyRaw).toBe(false);
			expect(store.getSecret(CREDENTIALS_KEY)).toBeNull();
		}
	});
});

describe('disconnectCredentials', () => {
	it('clears both keys locally', () => {
		const store = fakeStore({
			[CREDENTIALS_KEY]: JSON.stringify(validCreds()),
			[LEGACY_CREDENTIALS_KEY]: JSON.stringify(validCreds()),
		});
		disconnectCredentials(store);
		expect(store.getSecret(CREDENTIALS_KEY)).toBe('');
		expect(store.getSecret(LEGACY_CREDENTIALS_KEY)).toBe('');
		expect(readCredentials(store)).toBeNull();
	});
});

describe('historical SecretStorage key compatibility', () => {
	it('preserves the exact send-to-kindle credential keys across the rename', () => {
		expect(CREDENTIALS_KEY).toBe('send-to-kindle-credentials');
		expect(LEGACY_CREDENTIALS_KEY).toBe('stk-credentials');
	});

	it('loads credentials written under the old send-to-kindle key without reauthentication', () => {
		const store = fakeStore({ [CREDENTIALS_KEY]: JSON.stringify(validCreds()) });
		expect(readCredentials(store)).toEqual(validCreds());
	});

	it('loads credentials written under the legacy stk-credentials key via migration', () => {
		const store = fakeStore({ [LEGACY_CREDENTIALS_KEY]: JSON.stringify(validCreds()) });
		expect(migrateLegacyCredentials(store)).toBe(true);
		expect(readCredentials(store)).toEqual(validCreds());
	});

	it('disconnect clears both the current and legacy keys', () => {
		const store = fakeStore({
			[CREDENTIALS_KEY]: JSON.stringify(validCreds()),
			[LEGACY_CREDENTIALS_KEY]: JSON.stringify(validCreds()),
		});
		disconnectCredentials(store);
		expect(store.getSecret(CREDENTIALS_KEY)).toBe('');
		expect(store.getSecret(LEGACY_CREDENTIALS_KEY)).toBe('');
	});
});
