import { test, expect, describe } from 'bun:test';
import { encrypt, decrypt, isEncryptedValue, type EncryptedValue } from './crypto';

const TEST_KEY_MATERIAL = 'test-extension-id-abc123';

describe('isEncryptedValue', () => {
  test('returns true for valid EncryptedValue objects', () => {
    const valid: EncryptedValue = {
      $encrypted: true,
      ciphertext: 'abc123==',
      iv: 'def456==',
      salt: 'ghi789==',
    };
    expect(isEncryptedValue(valid)).toBe(true);
  });

  test('returns false for plain strings', () => {
    expect(isEncryptedValue('sk-ant-api03-...')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isEncryptedValue('')).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(isEncryptedValue(null)).toBe(false);
    expect(isEncryptedValue(undefined)).toBe(false);
  });

  test('returns false for objects missing required fields', () => {
    expect(isEncryptedValue({ $encrypted: true })).toBe(false);
    expect(isEncryptedValue({ $encrypted: true, ciphertext: 'a' })).toBe(false);
    expect(isEncryptedValue({ $encrypted: true, ciphertext: 'a', iv: 'b' })).toBe(false);
  });

  test('returns false for objects with wrong $encrypted value', () => {
    expect(
      isEncryptedValue({ $encrypted: false, ciphertext: 'a', iv: 'b', salt: 'c' })
    ).toBe(false);
  });
});

describe('encrypt / decrypt round-trip', () => {
  test('encrypts and decrypts a typical API key', async () => {
    const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
    const encrypted = await encrypt(apiKey, TEST_KEY_MATERIAL);

    expect(isEncryptedValue(encrypted)).toBe(true);
    expect(encrypted.ciphertext).not.toBe('');
    expect(encrypted.iv).not.toBe('');
    expect(encrypted.salt).not.toBe('');

    const decrypted = await decrypt(encrypted, TEST_KEY_MATERIAL);
    expect(decrypted).toBe(apiKey);
  });

  test('encrypts and decrypts an empty string', async () => {
    const encrypted = await encrypt('', TEST_KEY_MATERIAL);
    const decrypted = await decrypt(encrypted, TEST_KEY_MATERIAL);
    expect(decrypted).toBe('');
  });

  test('encrypts and decrypts unicode content', async () => {
    const text = 'sk-🔑-api-key-日本語';
    const encrypted = await encrypt(text, TEST_KEY_MATERIAL);
    const decrypted = await decrypt(encrypted, TEST_KEY_MATERIAL);
    expect(decrypted).toBe(text);
  });

  test('produces different ciphertext for the same input (random IV/salt)', async () => {
    const apiKey = 'sk-ant-test-key';
    const encrypted1 = await encrypt(apiKey, TEST_KEY_MATERIAL);
    const encrypted2 = await encrypt(apiKey, TEST_KEY_MATERIAL);

    // Ciphertexts should differ due to random IV and salt
    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
    expect(encrypted1.salt).not.toBe(encrypted2.salt);

    // But both should decrypt to the same value
    expect(await decrypt(encrypted1, TEST_KEY_MATERIAL)).toBe(apiKey);
    expect(await decrypt(encrypted2, TEST_KEY_MATERIAL)).toBe(apiKey);
  });
});

describe('decrypt with wrong key material', () => {
  test('throws when decrypting with different key material', async () => {
    const apiKey = 'sk-ant-api03-secret';
    const encrypted = await encrypt(apiKey, TEST_KEY_MATERIAL);

    await expect(decrypt(encrypted, 'wrong-extension-id')).rejects.toThrow();
  });
});

describe('tamper detection', () => {
  test('throws when ciphertext is tampered with', async () => {
    const encrypted = await encrypt('sk-ant-secret', TEST_KEY_MATERIAL);

    // Flip a character in the ciphertext
    const tampered: EncryptedValue = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + 'XX',
    };

    await expect(decrypt(tampered, TEST_KEY_MATERIAL)).rejects.toThrow();
  });

  test('throws when IV is tampered with', async () => {
    const encrypted = await encrypt('sk-ant-secret', TEST_KEY_MATERIAL);

    const tampered: EncryptedValue = {
      ...encrypted,
      iv: encrypted.iv.slice(0, -2) + 'XX',
    };

    await expect(decrypt(tampered, TEST_KEY_MATERIAL)).rejects.toThrow();
  });
});
