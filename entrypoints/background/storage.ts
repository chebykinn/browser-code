import type { Settings, SavedEdit, URLPattern } from '@/lib/types/messages';

const SETTINGS_KEY = 'settings';
const EDITS_KEY = 'edits';

// Default settings
const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  model: 'claude-opus-4-5-20251101',
  enabled: true,
};

/**
 * Get extension settings
 */
export async function getSettings(): Promise<Settings> {
  const result = await browser.storage.local.get(SETTINGS_KEY);
  const stored = result[SETTINGS_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * Save extension settings
 */
export async function saveSettings(settings: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const updated = { ...current, ...settings };
  await browser.storage.local.set({ [SETTINGS_KEY]: updated });
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
