import { test, expect, describe, beforeEach } from 'bun:test';
import { isEncryptedValue, encrypt, type EncryptedValue } from '@/lib/crypto';

// --- Mock browser.storage.local and browser.runtime.id ----------------------

const MOCK_EXTENSION_ID = 'mock-extension-id-xyz789';

/** In-memory storage backing the mock */
let store: Record<string, unknown> = {};

const mockBrowser = {
  runtime: { id: MOCK_EXTENSION_ID },
  storage: {
    local: {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      },
    },
  },
};

// Assign to globalThis so the module's bare `browser` references resolve
(globalThis as Record<string, unknown>).browser = mockBrowser;

// Import AFTER the mock is installed
const { getSettings, saveSettings } = await import('./storage');

// ---------------------------------------------------------------------------

beforeEach(() => {
  store = {};
});

describe('getSettings', () => {
  test('returns defaults when storage is empty', async () => {
    const settings = await getSettings();
    expect(settings).toEqual({
      apiKey: '',
      model: 'claude-opus-4-5-20251101',
      enabled: true,
    });
  });

  test('returns defaults when settings key exists but is empty object', async () => {
    store.settings = {};
    const settings = await getSettings();
    expect(settings.apiKey).toBe('');
    expect(settings.model).toBe('claude-opus-4-5-20251101');
    expect(settings.enabled).toBe(true);
  });

  test('decrypts an already-encrypted API key', async () => {
    const originalKey = 'sk-ant-api03-already-encrypted';
    const encrypted = await encrypt(originalKey, MOCK_EXTENSION_ID);

    store.settings = {
      apiKey: encrypted,
      model: 'claude-sonnet-4-20250514',
      enabled: false,
    };

    const settings = await getSettings();
    expect(settings.apiKey).toBe(originalKey);
    expect(settings.model).toBe('claude-sonnet-4-20250514');
    expect(settings.enabled).toBe(false);
  });
});

describe('plaintext migration', () => {
  test('migrates a plaintext API key to encrypted on first read', async () => {
    const plaintextKey = 'sk-ant-api03-plaintext-legacy-key';
    store.settings = {
      apiKey: plaintextKey,
      model: 'claude-opus-4-5-20251101',
      enabled: true,
    };

    // First read triggers migration
    const settings = await getSettings();
    expect(settings.apiKey).toBe(plaintextKey);

    // Verify the stored value is now encrypted
    const raw = store.settings as Record<string, unknown>;
    expect(isEncryptedValue(raw.apiKey)).toBe(true);

    // Verify non-apiKey fields were preserved during migration
    expect(raw.model).toBe('claude-opus-4-5-20251101');
    expect(raw.enabled).toBe(true);
  });

  test('migrated key decrypts correctly on subsequent reads', async () => {
    const plaintextKey = 'sk-ant-api03-will-be-migrated';
    store.settings = {
      apiKey: plaintextKey,
      model: 'claude-opus-4-5-20251101',
      enabled: true,
    };

    // First read: migrates
    await getSettings();

    // Second read: decrypts the migrated value
    const settings = await getSettings();
    expect(settings.apiKey).toBe(plaintextKey);
  });

  test('does not re-encrypt an already-encrypted key', async () => {
    const encrypted = await encrypt('sk-ant-test', MOCK_EXTENSION_ID);
    store.settings = { apiKey: encrypted, model: 'claude-opus-4-5-20251101', enabled: true };

    await getSettings();

    // The stored ciphertext should be the same object (not re-encrypted)
    const raw = store.settings as Record<string, unknown>;
    const storedEncrypted = raw.apiKey as EncryptedValue;
    expect(storedEncrypted.ciphertext).toBe(encrypted.ciphertext);
    expect(storedEncrypted.iv).toBe(encrypted.iv);
    expect(storedEncrypted.salt).toBe(encrypted.salt);
  });

  test('does not migrate an empty string key', async () => {
    store.settings = { apiKey: '', model: 'claude-opus-4-5-20251101', enabled: true };

    const settings = await getSettings();
    expect(settings.apiKey).toBe('');

    // Should still be a plain empty string, not an EncryptedValue
    const raw = store.settings as Record<string, unknown>;
    expect(raw.apiKey).toBe('');
  });
});

describe('saveSettings', () => {
  test('encrypts the API key when saving', async () => {
    const result = await saveSettings({ apiKey: 'sk-ant-new-key', model: 'claude-opus-4-5-20251101' });

    // Returned settings have the plaintext key
    expect(result.apiKey).toBe('sk-ant-new-key');

    // But storage has the encrypted form
    const raw = store.settings as Record<string, unknown>;
    expect(isEncryptedValue(raw.apiKey)).toBe(true);
  });

  test('stores empty string when apiKey is empty', async () => {
    await saveSettings({ apiKey: '', model: 'claude-opus-4-5-20251101' });

    const raw = store.settings as Record<string, unknown>;
    expect(raw.apiKey).toBe('');
  });

  test('round-trips through save then get', async () => {
    const key = 'sk-ant-api03-round-trip-test';
    await saveSettings({ apiKey: key, model: 'claude-sonnet-4-20250514' });

    const settings = await getSettings();
    expect(settings.apiKey).toBe(key);
    expect(settings.model).toBe('claude-sonnet-4-20250514');
  });

  test('merges partial updates with existing settings', async () => {
    await saveSettings({ apiKey: 'sk-ant-original', model: 'claude-opus-4-5-20251101', enabled: true });

    // Update only the model
    const result = await saveSettings({ model: 'claude-sonnet-4-20250514' });

    expect(result.apiKey).toBe('sk-ant-original');
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.enabled).toBe(true);
  });
});
