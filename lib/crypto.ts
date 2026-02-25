/**
 * AES-256-GCM encryption for sensitive values stored in browser.storage.
 *
 * Key derivation: PBKDF2 (SHA-256, 100k iterations) from caller-provided
 * key material (typically the extension's runtime.id) + a random 128-bit salt.
 *
 * Each encrypted value gets a unique random salt and IV, so encrypting the
 * same plaintext twice produces different ciphertexts.
 */

const PBKDF2_ITERATIONS = 100_000;
const AES_KEY_LENGTH = 256;
/** 96-bit IV as recommended for AES-GCM */
const IV_BYTES = 12;
/** 128-bit salt for PBKDF2 */
const SALT_BYTES = 16;

/**
 * Serializable representation of an encrypted value.
 * Stored in browser.storage.local in place of plaintext secrets.
 */
export interface EncryptedValue {
  /** Marker to distinguish encrypted objects from plain strings */
  $encrypted: true;
  /** Base64-encoded AES-GCM ciphertext */
  ciphertext: string;
  /** Base64-encoded 96-bit initialization vector */
  iv: string;
  /** Base64-encoded 128-bit PBKDF2 salt */
  salt: string;
}

/**
 * Type guard: returns true if `value` is an EncryptedValue object.
 */
export function isEncryptedValue(value: unknown): value is EncryptedValue {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.$encrypted === true &&
    typeof v.ciphertext === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.salt === 'string'
  );
}

// -- Internal helpers --------------------------------------------------------

function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function deriveKey(
  keyMaterial: string,
  salt: BufferSource
): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyMaterial),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    raw,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

// -- Public API --------------------------------------------------------------

/**
 * Encrypt a plaintext string.
 *
 * @param plaintext  - The secret to encrypt.
 * @param keyMaterial - Stable, per-installation string used to derive the
 *                      encryption key (e.g. `browser.runtime.id`).
 */
export async function encrypt(
  plaintext: string,
  keyMaterial: string
): Promise<EncryptedValue> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(keyMaterial, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  );

  return {
    $encrypted: true,
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    salt: toBase64(salt.buffer as ArrayBuffer),
  };
}

/**
 * Decrypt an EncryptedValue back to the original plaintext.
 *
 * Throws if the key material doesn't match or the ciphertext has been
 * tampered with (AES-GCM authentication tag verification failure).
 *
 * @param encrypted   - The EncryptedValue to decrypt.
 * @param keyMaterial - Must match the value used during encryption.
 */
export async function decrypt(
  encrypted: EncryptedValue,
  keyMaterial: string
): Promise<string> {
  const salt = fromBase64(encrypted.salt) as BufferSource;
  const iv = fromBase64(encrypted.iv) as BufferSource;
  const ciphertext = fromBase64(encrypted.ciphertext) as BufferSource;
  const key = await deriveKey(keyMaterial, salt);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintext);
}
