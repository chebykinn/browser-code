import type { Settings, SavedEdit, URLPattern } from '@/lib/types/messages';
import { encrypt, decrypt, isEncryptedValue } from '@/lib/crypto';

const SETTINGS_KEY = 'settings';
const EDITS_KEY = 'edits';

/** Raw shape of the settings object in browser.storage.local.
 *  The apiKey field may be a plaintext string (legacy) or an EncryptedValue. */
interface StoredSettings {
  apiKey: string | import('@/lib/crypto').EncryptedValue;
  model: string;
  enabled: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-4-5-20251101',
  enabled: true,
};

/**
 * Get extension settings.
 * Transparently decrypts the API key. If a legacy plaintext key is found,
 * it is encrypted in-place (migration).
 */
export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<StoredSettings> | undefined;

  if (!stored) return { ...DEFAULT_SETTINGS };

  let apiKey = '';

  if (isEncryptedValue(stored.apiKey)) {
    apiKey = await decrypt(stored.apiKey, browser.runtime.id);
  } else if (typeof stored.apiKey === 'string' && stored.apiKey !== '') {
    // Legacy plaintext key — encrypt it in-place for future reads
    apiKey = stored.apiKey;
    const encrypted = await encrypt(apiKey, browser.runtime.id);
    await browser.storage.local.set({
      [SETTINGS_KEY]: { ...stored, apiKey: encrypted },
    });
  }

  return {
    ...DEFAULT_SETTINGS,
    model: stored.model ?? DEFAULT_SETTINGS.model,
    enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
    apiKey,
  };
}

/**
 * Save extension settings.
 * Encrypts the API key before writing to storage.
 */
export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const updated = { ...current, ...settings };

  // Build the storage payload, encrypting the API key
  const toStore: Partial<StoredSettings> = {
    model: updated.model,
    enabled: updated.enabled,
  };

  if (updated.apiKey) {
    toStore.apiKey = await encrypt(updated.apiKey, browser.runtime.id);
  } else {
    toStore.apiKey = '';
  }

  await browser.storage.local.set({ [SETTINGS_KEY]: toStore });
  return updated;
}

/**
 * Get all saved edits
 */
export async function getAllEdits(): Promise<SavedEdit[]> {
  const result = await browser.storage.local.get(EDITS_KEY);
  return (result[EDITS_KEY] as SavedEdit[] | undefined) || [];
}

/**
 * Get edits matching a URL
 */
export async function getEditsForUrl(url: string): Promise<SavedEdit[]> {
  const allEdits = await getAllEdits();
  return allEdits.filter((edit) => matchesUrl(edit.urlPattern, url));
}

/**
 * Save a new edit
 */
export async function saveEdit(edit: SavedEdit): Promise<void> {
  const edits = await getAllEdits();
  const existingIndex = edits.findIndex((e) => e.id === edit.id);

  if (existingIndex >= 0) {
    edits[existingIndex] = edit;
  } else {
    edits.push(edit);
  }

  await browser.storage.local.set({ [EDITS_KEY]: edits });
}

/**
 * Delete an edit
 */
export async function deleteEdit(editId: string): Promise<void> {
  const edits = await getAllEdits();
  const filtered = edits.filter((e) => e.id !== editId);
  await browser.storage.local.set({ [EDITS_KEY]: filtered });
}

/**
 * Check if a URL matches a pattern
 */
function matchesUrl(pattern: URLPattern, url: string): boolean {
  try {
    switch (pattern.type) {
      case 'exact':
        return url === pattern.value;

      case 'domain': {
        const urlObj = new URL(url);
        const domain = pattern.value.toLowerCase();
        const hostname = urlObj.hostname.toLowerCase();
        return hostname === domain || hostname.endsWith('.' + domain);
      }

      case 'pattern': {
        // Convert glob pattern to regex
        const regex = globToRegex(pattern.value);
        return regex.test(url);
      }

      case 'regex': {
        const regex = new RegExp(pattern.value);
        return regex.test(url);
      }

      default:
        return false;
    }
  } catch {
    return false;
  }
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$');
}
