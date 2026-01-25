/**
 * Cross-browser file reading via file:// URLs
 *
 * Requires:
 * - file:///* in host_permissions
 * - User enables "Allow access to file URLs" in extension settings
 */

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: number;
}

export interface ReadError {
  type: 'permission' | 'not-found' | 'network' | 'parse';
  message: string;
}

/**
 * Read a local file via file:// URL
 */
export async function readLocalFile(path: string): Promise<string> {
  // Ensure path starts with file://
  const url = path.startsWith('file://') ? path : `file://${path}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to read file: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      throw new Error(`Permission denied or file not found: ${path}. Ensure "Allow access to file URLs" is enabled in extension settings.`);
    }
    throw error;
  }
}

/**
 * List directory contents by parsing file:// directory listing
 * Note: Browser directory listings vary, this attempts to parse common formats
 */
export async function listDirectory(path: string): Promise<FileEntry[]> {
  const url = path.startsWith('file://') ? path : `file://${path}`;
  // Ensure trailing slash for directory
  const dirUrl = url.endsWith('/') ? url : `${url}/`;

  try {
    const response = await fetch(dirUrl);

    if (!response.ok) {
      throw new Error(`Failed to list directory: ${response.status}`);
    }

    const html = await response.text();
    return parseDirectoryListing(html, dirUrl);
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      throw new Error(`Permission denied or directory not found: ${path}`);
    }
    throw error;
  }
}

/**
 * Parse browser directory listing HTML
 * Handles Chrome and Firefox formats
 */
function parseDirectoryListing(html: string, baseUrl: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Chrome format: table with Name, Size, Date Modified columns
  const rows = doc.querySelectorAll('table tr');
  if (rows.length > 0) {
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 1) {
        const link = cells[0]?.querySelector('a');
        if (link) {
          const name = link.textContent?.trim() || '';
          const href = link.getAttribute('href') || '';

          // Skip parent directory link
          if (name === '..' || name === '../' || href === '../') continue;

          const isDirectory = name.endsWith('/') || href.endsWith('/');
          const cleanName = name.replace(/\/$/, '');

          entries.push({
            name: cleanName,
            path: new URL(href, baseUrl).href,
            isDirectory,
            size: cells[1]?.textContent ? parseSize(cells[1].textContent) : undefined,
            modified: cells[2]?.textContent ? parseDate(cells[2].textContent) : undefined,
          });
        }
      }
    }
    return entries;
  }

  // Firefox format: list of links
  const links = doc.querySelectorAll('a');
  for (const link of links) {
    const name = link.textContent?.trim() || '';
    const href = link.getAttribute('href') || '';

    // Skip parent directory and self links
    if (name === '..' || name === '../' || name === '.' || href === '../') continue;

    const isDirectory = name.endsWith('/') || href.endsWith('/');
    const cleanName = name.replace(/\/$/, '');

    if (cleanName) {
      entries.push({
        name: cleanName,
        path: new URL(href, baseUrl).href,
        isDirectory,
      });
    }
  }

  return entries;
}

/**
 * Parse size string (e.g., "1.5 KB", "2 MB")
 */
function parseSize(sizeStr: string): number | undefined {
  const match = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|MB|GB)?$/i);
  if (!match) return undefined;

  const value = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();

  const multipliers: Record<string, number> = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
  };

  return value * (multipliers[unit] || 1);
}

/**
 * Parse date string to timestamp
 */
function parseDate(dateStr: string): number | undefined {
  const date = new Date(dateStr.trim());
  return isNaN(date.getTime()) ? undefined : date.getTime();
}

/**
 * Recursively list all files in a directory
 */
export async function listAllFiles(
  path: string,
  extensions?: string[]
): Promise<FileEntry[]> {
  const allFiles: FileEntry[] = [];
  const entries = await listDirectory(path);

  for (const entry of entries) {
    if (entry.isDirectory) {
      // Recursively list subdirectory
      const subFiles = await listAllFiles(entry.path, extensions);
      allFiles.push(...subFiles);
    } else {
      // Check extension filter
      if (extensions && extensions.length > 0) {
        const ext = entry.name.split('.').pop()?.toLowerCase();
        if (!ext || !extensions.includes(ext)) continue;
      }
      allFiles.push(entry);
    }
  }

  return allFiles;
}

/**
 * Compute simple hash for content comparison
 * Uses djb2 algorithm for speed
 */
export function computeHash(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash) + content.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Check if file:// access is available
 */
export async function checkFileAccess(testPath: string): Promise<boolean> {
  try {
    await readLocalFile(testPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Request file:// permission (Firefox)
 * Returns true if permission granted
 */
export async function requestFilePermission(): Promise<boolean> {
  try {
    const granted = await browser.permissions.request({
      origins: ['file:///*'],
    });
    return granted;
  } catch (error) {
    console.error('[Sync] Failed to request file permission:', error);
    return false;
  }
}

/**
 * Check if we have file:// permission
 */
export async function hasFilePermission(): Promise<boolean> {
  try {
    const result = await browser.permissions.contains({
      origins: ['file:///*'],
    });
    return result;
  } catch {
    return false;
  }
}
