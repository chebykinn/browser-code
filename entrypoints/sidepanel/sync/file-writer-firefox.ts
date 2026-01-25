/**
 * Firefox file writing using Downloads API
 *
 * Files are saved to Downloads/browser-code-fs/{domain}/{path}/...
 * Uses:
 * - filename: creates subfolders automatically
 * - conflictAction: "overwrite" to update existing files
 * - incognito: true to avoid polluting download history
 * - saveAs: false to skip the save dialog
 */

const BASE_FOLDER = 'browser-code-fs';

/**
 * Create a blob URL for content
 */
function createBlobUrl(content: string, mimeType = 'text/plain'): string {
  const blob = new Blob([content], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Revoke a blob URL after use
 */
function revokeBlobUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/**
 * Sanitize path component for filesystem
 */
function sanitizePath(path: string): string {
  // Remove or replace invalid characters
  return path
    .replace(/[<>:"|?*]/g, '_')  // Windows invalid chars
    .replace(/\\/g, '/')          // Normalize slashes
    .replace(/\/+/g, '/')         // Collapse multiple slashes
    .replace(/^\/|\/$/g, '');     // Trim leading/trailing slashes
}

/**
 * Get MIME type for file extension
 */
function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    'js': 'application/javascript',
    'css': 'text/css',
    'json': 'application/json',
    'html': 'text/html',
    'txt': 'text/plain',
  };
  return mimeTypes[ext || ''] || 'text/plain';
}

/**
 * Write a file using Downloads API
 *
 * @param relativePath - Path relative to browser-code-fs folder (e.g., "example.com/scripts/app.js")
 * @param content - File content
 * @returns Download ID
 */
export async function writeFile(
  relativePath: string,
  content: string
): Promise<number> {
  const sanitizedPath = sanitizePath(relativePath);
  const filename = `${BASE_FOLDER}/${sanitizedPath}`;
  const mimeType = getMimeType(sanitizedPath);

  const blobUrl = createBlobUrl(content, mimeType);

  try {
    const downloadId = await browser.downloads.download({
      url: blobUrl,
      filename,
      conflictAction: 'overwrite',
      saveAs: false,
      // @ts-expect-error - incognito is valid but not in all type defs
      incognito: true,
    }) as unknown as number;

    return downloadId;
  } finally {
    // Clean up blob URL after a delay to ensure download starts
    setTimeout(() => revokeBlobUrl(blobUrl), 1000);
  }
}

/**
 * Write multiple files
 */
export async function writeFiles(
  files: Array<{ path: string; content: string }>
): Promise<number[]> {
  const downloadIds: number[] = [];

  for (const file of files) {
    const id = await writeFile(file.path, file.content);
    downloadIds.push(id);
  }

  return downloadIds;
}

/**
 * Export all VFS data as a JSON file
 */
export async function exportAsJson(
  data: unknown,
  filename = 'browser-code-export.json'
): Promise<number> {
  const content = JSON.stringify(data, null, 2);
  const blobUrl = createBlobUrl(content, 'application/json');

  try {
    return await browser.downloads.download({
      url: blobUrl,
      filename: `${BASE_FOLDER}/${filename}`,
      conflictAction: 'overwrite',
      saveAs: false,
      // @ts-expect-error - incognito is valid
      incognito: true,
    }) as unknown as number;
  } finally {
    setTimeout(() => revokeBlobUrl(blobUrl), 1000);
  }
}

/**
 * Normalize path: handle root urlPath, remove double slashes
 */
function normalizeSyncPath(domain: string, urlPath: string, type: string, name: string): string {
  const pathPart = urlPath === '/' || urlPath === '' ? '' : urlPath;
  const fullPath = `${domain}${pathPart}/${type}/${name}`;
  return fullPath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Export files as individual downloads
 */
export async function exportFiles(
  files: Array<{ domain: string; urlPath: string; type: 'scripts' | 'styles'; name: string; content: string }>
): Promise<number[]> {
  const downloadIds: number[] = [];

  for (const file of files) {
    const relativePath = normalizeSyncPath(file.domain, file.urlPath, file.type, file.name);
    const id = await writeFile(relativePath, file.content);
    downloadIds.push(id);
  }

  return downloadIds;
}

interface DownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
}

/**
 * Watch for download completion
 */
export function onDownloadComplete(
  downloadId: number,
  callback: (success: boolean, error?: string) => void
): () => void {
  const listener = (delta: DownloadDelta) => {
    if (delta.id !== downloadId) return;

    if (delta.state?.current === 'complete') {
      callback(true);
      browser.downloads.onChanged.removeListener(listener);
    } else if (delta.error?.current) {
      callback(false, delta.error.current);
      browser.downloads.onChanged.removeListener(listener);
    }
  };

  browser.downloads.onChanged.addListener(listener);

  // Return cleanup function
  return () => browser.downloads.onChanged.removeListener(listener);
}

/**
 * Wait for download to complete
 */
export function waitForDownload(downloadId: number): Promise<boolean> {
  return new Promise((resolve) => {
    onDownloadComplete(downloadId, (success) => resolve(success));
  });
}

/**
 * Get the expected output path for a file
 */
export function getExpectedPath(relativePath: string): string {
  return `${BASE_FOLDER}/${sanitizePath(relativePath)}`;
}

/**
 * Check if Downloads API is available
 */
export function isAvailable(): boolean {
  return typeof browser !== 'undefined' && browser.downloads?.download !== undefined;
}
