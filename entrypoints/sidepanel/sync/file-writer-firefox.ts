/**
 * Firefox file writing using Downloads API
 *
 * Files are saved to Downloads/browser-code-fs/{domain}/{path}/...
 * Uses:
 * - filename: creates subfolders automatically
 * - conflictAction: "overwrite" to update existing files
 * - saveAs: false to skip the save dialog
 * - erase: removes from download history after completion (incognito not supported in Firefox)
 */

import type { DownloadResult } from './types';

const BASE_FOLDER = 'browser-code-fs';
const DOWNLOAD_TIMEOUT_MS = 30000; // 30 second timeout for downloads

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

interface DownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
}

/**
 * Wait for download to complete with timeout
 */
function waitForDownloadWithTimeout(
  downloadId: number,
  timeoutMs: number = DOWNLOAD_TIMEOUT_MS
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        browser.downloads.onChanged.removeListener(listener);
      }
    };

    const listener = (delta: DownloadDelta) => {
      if (delta.id !== downloadId) return;

      if (delta.state?.current === 'complete') {
        cleanup();
        resolve({ success: true });
      } else if (delta.error?.current) {
        cleanup();
        resolve({ success: false, error: delta.error.current });
      }
    };

    browser.downloads.onChanged.addListener(listener);

    // Timeout handler
    setTimeout(() => {
      if (!resolved) {
        cleanup();
        resolve({ success: false, error: 'Download timed out' });
      }
    }, timeoutMs);
  });
}

/**
 * Erase download from history (keeps file on disk)
 */
async function eraseFromHistory(downloadId: number): Promise<void> {
  try {
    await browser.downloads.erase({ id: downloadId });
  } catch (error) {
    // Silently ignore erase errors - not critical
    console.debug('[Sync] Failed to erase download from history:', error);
  }
}

/**
 * Write a file using Downloads API
 *
 * @param relativePath - Path relative to browser-code-fs folder (e.g., "example.com/scripts/app.js")
 * @param content - File content
 * @returns DownloadResult with success status
 */
export async function writeFile(
  relativePath: string,
  content: string
): Promise<DownloadResult> {
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
      // Note: incognito: true is NOT supported in Firefox and causes silent failures
    }) as unknown as number;

    // Wait for download to complete
    const result = await waitForDownloadWithTimeout(downloadId);

    // Clean up blob URL after download completes (not on timer)
    revokeBlobUrl(blobUrl);

    if (result.success) {
      // Remove from download history to keep it clean (like incognito would)
      await eraseFromHistory(downloadId);
      return { downloadId, success: true };
    } else {
      return { downloadId, success: false, error: result.error };
    }
  } catch (error) {
    // Clean up blob URL on error
    revokeBlobUrl(blobUrl);
    const errorMessage = error instanceof Error ? error.message : 'Unknown download error';
    return { downloadId: -1, success: false, error: errorMessage };
  }
}

/**
 * Write multiple files
 */
export async function writeFiles(
  files: Array<{ path: string; content: string }>
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];

  for (const file of files) {
    const result = await writeFile(file.path, file.content);
    results.push(result);
  }

  return results;
}

/**
 * Export all VFS data as a JSON file
 */
export async function exportAsJson(
  data: unknown,
  filename = 'browser-code-export.json'
): Promise<DownloadResult> {
  const content = JSON.stringify(data, null, 2);
  return writeFile(filename, content);
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
): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];

  for (const file of files) {
    const relativePath = normalizeSyncPath(file.domain, file.urlPath, file.type, file.name);
    const result = await writeFile(relativePath, file.content);
    results.push(result);
  }

  return results;
}

/**
 * Watch for download completion (legacy compatibility)
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
 * Wait for download to complete (legacy compatibility)
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
