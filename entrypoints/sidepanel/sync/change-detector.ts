/**
 * Change detection for local files and VFS
 *
 * - Polls local files via file:// URLs
 * - Watches VFS via browser.storage.onChanged
 * - Detects conflicts when both sides changed
 */

import { readLocalFile, listAllFiles, computeHash, type FileEntry } from './file-reader';
import type { SyncMetadata, FileMetadata, SyncChange, SyncDirection } from './types';

/**
 * Normalize path: convert backslashes, remove double slashes, handle root urlPath
 */
function normalizePath(domain: string, urlPath: string, type: string, name: string): string {
  const pathPart = urlPath === '/' || urlPath === '' ? '' : urlPath;
  const fullPath = `${domain}${pathPart}/${type}/${name}`;
  return fullPath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export interface LocalFileState {
  path: string;
  content: string;
  hash: string;
}

export interface VfsFileState {
  domain: string;
  urlPath: string;
  type: 'scripts' | 'styles';
  name: string;
  content: string;
  version: number;
  modified: number;
}

export interface ChangeSet {
  localChanges: LocalFileState[];
  vfsChanges: VfsFileState[];
  conflicts: Array<{
    path: string;
    local: LocalFileState;
    vfs: VfsFileState;
  }>;
}

/**
 * Poll local files for changes
 */
export class LocalFileWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private fileHashes: Map<string, string> = new Map();
  private localPath: string;
  private extensions: string[];
  private onChanges: (changes: LocalFileState[]) => void;

  constructor(
    localPath: string,
    extensions: string[],
    onChanges: (changes: LocalFileState[]) => void
  ) {
    this.localPath = localPath;
    this.extensions = extensions;
    this.onChanges = onChanges;
  }

  /**
   * Start polling for changes
   */
  start(intervalMs = 3000): void {
    if (this.intervalId) return;

    // Initial scan
    this.scan();

    // Start polling
    this.intervalId = setInterval(() => this.scan(), intervalMs);
  }

  /**
   * Stop polling
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Scan for changes
   */
  private async scan(): Promise<void> {
    try {
      const files = await listAllFiles(this.localPath, this.extensions);
      const changes: LocalFileState[] = [];

      for (const file of files) {
        try {
          const content = await readLocalFile(file.path);
          const hash = computeHash(content);
          const previousHash = this.fileHashes.get(file.path);

          if (previousHash !== hash) {
            changes.push({
              path: file.path,
              content,
              hash,
            });
            this.fileHashes.set(file.path, hash);
          }
        } catch (error) {
          console.warn(`[Sync] Failed to read file ${file.path}:`, error);
        }
      }

      if (changes.length > 0) {
        this.onChanges(changes);
      }
    } catch (error) {
      console.error('[Sync] Failed to scan local files:', error);
    }
  }

  /**
   * Get current file hashes
   */
  getHashes(): Map<string, string> {
    return new Map(this.fileHashes);
  }

  /**
   * Set initial hashes (e.g., from saved metadata)
   */
  setHashes(hashes: Map<string, string>): void {
    this.fileHashes = new Map(hashes);
  }
}

/**
 * Watch VFS storage for changes
 */
export class VfsWatcher {
  private listener: ((changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void) | null = null;
  private onChanges: (changes: VfsFileState[]) => void;

  constructor(onChanges: (changes: VfsFileState[]) => void) {
    this.onChanges = onChanges;
  }

  /**
   * Start watching VFS changes
   */
  start(): void {
    if (this.listener) return;

    this.listener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => {
      const vfsChanges: VfsFileState[] = [];

      for (const [key, change] of Object.entries(changes)) {
        // Only watch vfs:* keys
        if (!key.startsWith('vfs:')) continue;

        const domain = key.replace('vfs:', '');
        const newValue = change.newValue as any;

        if (newValue?.paths) {
          for (const [urlPath, pathData] of Object.entries(newValue.paths as Record<string, any>)) {
            // Check scripts
            if (pathData.scripts) {
              for (const [name, file] of Object.entries(pathData.scripts as Record<string, any>)) {
                vfsChanges.push({
                  domain,
                  urlPath,
                  type: 'scripts',
                  name,
                  content: file.content,
                  version: file.version,
                  modified: file.modified || Date.now(),
                });
              }
            }

            // Check styles
            if (pathData.styles) {
              for (const [name, file] of Object.entries(pathData.styles as Record<string, any>)) {
                vfsChanges.push({
                  domain,
                  urlPath,
                  type: 'styles',
                  name,
                  content: file.content,
                  version: file.version,
                  modified: file.modified || Date.now(),
                });
              }
            }
          }
        }
      }

      if (vfsChanges.length > 0) {
        this.onChanges(vfsChanges);
      }
    };

    browser.storage.local.onChanged.addListener(this.listener);
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.listener) {
      browser.storage.local.onChanged.removeListener(this.listener);
      this.listener = null;
    }
  }
}

/**
 * Compare local and VFS states to detect changes and conflicts
 */
export function detectChanges(
  localFiles: LocalFileState[],
  vfsFiles: VfsFileState[],
  metadata: SyncMetadata
): ChangeSet {
  const changes: ChangeSet = {
    localChanges: [],
    vfsChanges: [],
    conflicts: [],
  };

  // Build VFS path map
  const vfsMap = new Map<string, VfsFileState>();
  for (const vfs of vfsFiles) {
    const path = normalizePath(vfs.domain, vfs.urlPath, vfs.type, vfs.name);
    vfsMap.set(path, vfs);
  }

  // Check local files
  for (const local of localFiles) {
    const relativePath = extractRelativePath(local.path);
    if (!relativePath) continue;

    const meta = metadata.files[relativePath];
    const vfs = vfsMap.get(relativePath);

    if (!meta) {
      // New local file
      changes.localChanges.push(local);
    } else if (local.hash !== meta.hash) {
      // Local file changed
      if (vfs && vfs.version > meta.vfsVersion) {
        // Both changed - conflict
        changes.conflicts.push({ path: relativePath, local, vfs });
      } else {
        // Only local changed
        changes.localChanges.push(local);
      }
    }
  }

  // Check VFS files for new/changed files not in local
  for (const vfs of vfsFiles) {
    const path = normalizePath(vfs.domain, vfs.urlPath, vfs.type, vfs.name);
    const meta = metadata.files[path];

    if (!meta) {
      // New VFS file
      changes.vfsChanges.push(vfs);
    } else if (vfs.version > meta.vfsVersion) {
      const localHash = computeHash(vfs.content);
      if (localHash !== meta.hash) {
        // VFS changed and content is different
        // Check if already added as conflict
        if (!changes.conflicts.some(c => c.path === path)) {
          changes.vfsChanges.push(vfs);
        }
      }
    }
  }

  return changes;
}

/**
 * Extract relative path from file:// URL
 */
function extractRelativePath(fileUrl: string): string | null {
  // Expected format: file:///path/to/sync-folder/{domain}/{urlPath}/{type}/{name}
  // We need to extract: {domain}/{urlPath}/{type}/{name}

  // Remove file:// prefix
  const path = fileUrl.replace(/^file:\/\//, '');

  // Find the first path segment that looks like a domain
  const segments = path.split('/').filter(Boolean);

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // Check if this looks like a domain (contains a dot or is localhost)
    if (segment.includes('.') || segment === 'localhost') {
      return segments.slice(i).join('/');
    }
  }

  return null;
}

/**
 * Determine sync direction for a change
 */
export function getSyncDirection(
  localHash: string | undefined,
  vfsVersion: number | undefined,
  metadata: FileMetadata | undefined
): SyncDirection {
  if (!metadata) {
    // New file - check which side has it
    if (localHash && !vfsVersion) return 'local-to-vfs';
    if (!localHash && vfsVersion) return 'vfs-to-local';
    return 'conflict'; // Both new - conflict
  }

  const localChanged = localHash !== metadata.hash;
  const vfsChanged = (vfsVersion || 0) > metadata.vfsVersion;

  if (localChanged && vfsChanged) return 'conflict';
  if (localChanged) return 'local-to-vfs';
  if (vfsChanged) return 'vfs-to-local';

  return 'local-to-vfs'; // Default: no change
}
