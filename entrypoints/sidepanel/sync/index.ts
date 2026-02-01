/**
 * VFS Local Filesystem Sync Manager
 *
 * Coordinates bidirectional sync between VFS and local filesystem.
 * - Chrome: Uses File System Access API for direct read/write
 * - Firefox: Uses file:// fetch for read, Downloads API for write
 */

import type {
  SyncConfig,
  SyncState,
  SyncMetadata,
  SyncResult,
  ConflictInfo,
  BrowserType,
  DownloadResult,
} from './types';
import { detectBrowser, hasFileSystemAccess } from './types';
import { readLocalFile, listAllFiles, computeHash } from './file-reader';
import * as chromeWriter from './file-writer-chrome';
import * as firefoxWriter from './file-writer-firefox';
import { LocalFileWatcher, VfsWatcher, detectChanges, type LocalFileState, type VfsFileState } from './change-detector';

const SYNC_CONFIG_KEY = 'sync-config';
const SYNC_METADATA_KEY = 'sync-metadata';

/**
 * Normalize path: convert backslashes, remove double slashes, handle root urlPath
 */
function normalizePath(domain: string, urlPath: string, type: string, name: string): string {
  // Handle root path (urlPath = '/' or '')
  const pathPart = urlPath === '/' || urlPath === '' ? '' : urlPath;
  const fullPath = `${domain}${pathPart}/${type}/${name}`;
  // Normalize slashes
  return fullPath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

type SyncEventType = 'status-change' | 'sync-complete' | 'conflict' | 'error';
type SyncEventCallback = (data: any) => void;

export class SyncManager {
  private browser: BrowserType;
  private config: SyncConfig | null = null;
  private state: SyncState = {
    status: 'disabled',
    lastSync: null,
    pendingChanges: 0,
    error: null,
  };
  private metadata: SyncMetadata = {
    version: 1,
    lastSync: 0,
    files: {},
  };
  private localWatcher: LocalFileWatcher | null = null;
  private vfsWatcher: VfsWatcher | null = null;
  private listeners: Map<SyncEventType, Set<SyncEventCallback>> = new Map();
  private syncInProgress = false;

  // Debouncing state for VFS changes
  private pendingVfsChanges: VfsFileState[] = [];
  private vfsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly VFS_DEBOUNCE_MS = 500;

  // Firefox periodic sync fallback (in case onChanged relay fails)
  private firefoxSyncInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.browser = detectBrowser();
  }

  /**
   * Initialize the sync manager
   */
  async init(): Promise<void> {
    // Load saved config and metadata
    const stored = await browser.storage.local.get([SYNC_CONFIG_KEY, SYNC_METADATA_KEY]);

    if (stored[SYNC_CONFIG_KEY]) {
      this.config = stored[SYNC_CONFIG_KEY] as SyncConfig;
    }

    if (stored[SYNC_METADATA_KEY]) {
      this.metadata = stored[SYNC_METADATA_KEY] as SyncMetadata;
    }

    // Restore Chrome directory handle if available
    if (this.browser === 'chrome' && hasFileSystemAccess()) {
      const handle = await chromeWriter.getHandle();
      if (handle && this.config) {
        const hasPermission = await chromeWriter.verifyPermission(handle);
        if (hasPermission) {
          this.config.directoryHandle = handle;
        }
      }
    }

    // Auto-start sync if it was previously enabled
    if (this.config?.enabled) {
      await this.startSync();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): SyncConfig | null {
    return this.config;
  }

  /**
   * Get current state
   */
  getState(): SyncState {
    return { ...this.state };
  }

  /**
   * Get browser type
   */
  getBrowser(): BrowserType {
    return this.browser;
  }

  /**
   * Check if File System Access API is available (Chrome)
   */
  hasDirectWrite(): boolean {
    return hasFileSystemAccess();
  }

  /**
   * Update configuration
   */
  async setConfig(config: Partial<SyncConfig>): Promise<void> {
    this.config = {
      enabled: false,
      localPath: '',
      syncInterval: 3000,
      conflictResolution: 'newest',
      ...this.config,
      ...config,
    };

    await browser.storage.local.set({ [SYNC_CONFIG_KEY]: this.config });

    // Update watchers if needed
    if (this.config.enabled) {
      await this.startSync();
    } else {
      this.stopSync();
    }
  }

  /**
   * Select output directory (Chrome only)
   */
  async selectDirectory(): Promise<boolean> {
    if (!hasFileSystemAccess()) {
      throw new Error('File System Access API not available');
    }

    const handle = await chromeWriter.selectDirectory();
    if (handle) {
      await this.setConfig({ directoryHandle: handle });
      return true;
    }
    return false;
  }

  /**
   * Start sync
   */
  async startSync(): Promise<void> {
    if (!this.config?.enabled) {
      return;
    }

    this.stopSync(); // Stop any existing watchers

    // Chrome: Start polling the selected directory (using File System Access API)
    if (this.browser === 'chrome' && this.config.directoryHandle) {
      this.startChromeWatcher();
    }

    // Start VFS watcher (both browsers - for auto-export)
    this.vfsWatcher = new VfsWatcher((changes) => this.handleVfsChanges(changes));
    this.vfsWatcher.start();

    // Firefox: Start periodic sync as fallback
    // Firefox MV3 doesn't reliably fire storage.onChanged cross-context
    if (this.browser === 'firefox') {
      const FIREFOX_SYNC_INTERVAL = 5000; // 5 seconds
      this.firefoxSyncInterval = setInterval(async () => {
        const result = await this.syncNow();
        console.log(`[Sync] Periodic: ${result.synced} synced, ${result.errors.length} errors`);
      }, FIREFOX_SYNC_INTERVAL);
    }

    this.setState({ status: 'idle', error: null });

    // Cleanup duplicate paths before initial export
    await this.cleanupDuplicatePaths();

    // Initial sync: export all existing VFS files
    // Skip on Firefox - the Downloads API crashes on bulk exports during init
    // The periodic sync will pick up files gradually
    if (this.browser !== 'firefox') {
      await this.initialExport();
    }
  }

  /**
   * Cleanup duplicate VFS paths (e.g., '/path' and '/path/')
   */
  private async cleanupDuplicatePaths(): Promise<void> {
    try {
      const response = await browser.runtime.sendMessage({ type: 'CLEANUP_VFS_PATHS' });
      if (response.merged > 0) {
        console.log(`[Sync] Cleaned up ${response.merged} duplicate path(s)`);
      }
    } catch (error) {
      console.error('[Sync] Failed to cleanup duplicate paths:', error);
    }
  }

  private chromeWatcherInterval: ReturnType<typeof setInterval> | null = null;
  private chromeFileHashes: Map<string, string> = new Map();

  /**
   * Start Chrome file watcher using File System Access API
   */
  private startChromeWatcher(): void {
    if (!this.config?.directoryHandle) return;

    // Initial scan
    this.scanChromeDirectory();

    // Start polling
    this.chromeWatcherInterval = setInterval(
      () => this.scanChromeDirectory(),
      this.config.syncInterval
    );
  }

  /**
   * Scan Chrome directory for changes
   */
  private async scanChromeDirectory(): Promise<void> {
    if (!this.config?.directoryHandle) return;

    try {
      const files = await chromeWriter.listFiles(this.config.directoryHandle);
      const changes: LocalFileState[] = [];

      for (const file of files) {
        // Only process .js and .css files
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (ext !== 'js' && ext !== 'css') continue;

        try {
          const content = await chromeWriter.readFile(this.config.directoryHandle!, file.path);
          const hash = computeHash(content);
          const previousHash = this.chromeFileHashes.get(file.path);

          if (previousHash !== hash) {
            changes.push({ path: file.path, content, hash });
            this.chromeFileHashes.set(file.path, hash);
          }
        } catch (error) {
          console.warn(`[Sync] Failed to read file ${file.path}:`, error);
        }
      }

      if (changes.length > 0) {
        this.handleLocalChanges(changes);
      }
    } catch (error) {
      console.error('[Sync] Failed to scan Chrome directory:', error);
    }
  }

  /**
   * Stop Chrome watcher
   */
  private stopChromeWatcher(): void {
    if (this.chromeWatcherInterval) {
      clearInterval(this.chromeWatcherInterval);
      this.chromeWatcherInterval = null;
    }
  }

  /**
   * Export all existing VFS files on sync enable
   */
  private async initialExport(): Promise<void> {
    this.setState({ status: 'syncing' });

    try {
      const vfsFiles = await this.getVfsFiles();

      if (vfsFiles.length === 0) {
        this.setState({ status: 'idle', lastSync: Date.now() });
        return;
      }

      // Export all VFS files to local
      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      for (const vfs of vfsFiles) {
        const result = await this.syncVfsToLocal(vfs);
        if (result.success) {
          successCount++;
          const path = normalizePath(vfs.domain, vfs.urlPath, vfs.type, vfs.name);
          this.updateFileMetadata(path, computeHash(vfs.content), vfs.version);
        } else {
          errorCount++;
          const errorMsg = `Failed to export ${vfs.name}: ${result.error || 'Unknown error'}`;
          errors.push(errorMsg);
          console.error(`[Sync] ${errorMsg}`);
        }
      }

      await this.saveMetadata();

      if (errorCount > 0) {
        this.setState({
          status: 'idle',
          lastSync: Date.now(),
          pendingChanges: 0,
          error: `${errorCount} file(s) failed to sync`,
        });
        this.emit('sync-complete', { success: false, synced: successCount, conflicts: [], errors });
      } else {
        this.setState({ status: 'idle', lastSync: Date.now(), pendingChanges: 0, error: null });
        this.emit('sync-complete', { success: true, synced: successCount, conflicts: [], errors: [] });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.setState({ status: 'error', error: errorMessage });
      this.emit('error', { error: errorMessage });
    }
  }

  /**
   * Stop sync
   */
  stopSync(): void {
    this.stopChromeWatcher();

    if (this.localWatcher) {
      this.localWatcher.stop();
      this.localWatcher = null;
    }

    if (this.vfsWatcher) {
      this.vfsWatcher.stop();
      this.vfsWatcher = null;
    }

    // Clear Firefox periodic sync interval
    if (this.firefoxSyncInterval) {
      clearInterval(this.firefoxSyncInterval);
      this.firefoxSyncInterval = null;
    }

    // Clear debounce timer
    if (this.vfsDebounceTimer) {
      clearTimeout(this.vfsDebounceTimer);
      this.vfsDebounceTimer = null;
    }
    this.pendingVfsChanges = [];

    this.setState({ status: 'disabled' });
  }

  /**
   * Trigger manual sync
   */
  async syncNow(): Promise<SyncResult> {
    if (this.syncInProgress) {
      return { success: false, synced: 0, conflicts: [], errors: ['Sync already in progress'] };
    }

    this.syncInProgress = true;
    this.setState({ status: 'syncing' });

    try {
      const result = await this.performSync();

      this.metadata.lastSync = Date.now();
      await this.saveMetadata();

      this.setState({
        status: 'idle',
        lastSync: Date.now(),
        pendingChanges: 0,
        error: result.errors.length > 0 ? result.errors[0] : null,
      });

      this.emit('sync-complete', result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.setState({ status: 'error', error: errorMessage });
      this.emit('error', { error: errorMessage });
      return { success: false, synced: 0, conflicts: [], errors: [errorMessage] };
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Perform the actual sync
   */
  private async performSync(): Promise<SyncResult> {
    if (!this.config) {
      return { success: false, synced: 0, conflicts: [], errors: ['No configuration'] };
    }

    const result: SyncResult = { success: true, synced: 0, conflicts: [], errors: [] };

    // Get local files (Chrome only - using File System Access API)
    let localFiles: LocalFileState[] = [];
    if (this.browser === 'chrome' && this.config.directoryHandle) {
      try {
        const files = await chromeWriter.listFiles(this.config.directoryHandle);
        for (const file of files) {
          // Only process .js and .css files
          const ext = file.name.split('.').pop()?.toLowerCase();
          if (ext !== 'js' && ext !== 'css') continue;

          const content = await chromeWriter.readFile(this.config.directoryHandle!, file.path);
          localFiles.push({
            path: file.path,
            content,
            hash: computeHash(content),
          });
        }
      } catch (error) {
        result.errors.push(`Failed to read local files: ${(error as Error).message}`);
      }
    }

    // Get VFS files
    const vfsFiles = await this.getVfsFiles();

    // Detect changes (for Chrome: bidirectional, for Firefox: VFS→local only)
    const changes = detectChanges(localFiles, vfsFiles, this.metadata);

    // Handle conflicts (Chrome only)
    if (this.browser === 'chrome') {
      for (const conflict of changes.conflicts) {
        if (this.config.conflictResolution === 'ask') {
          result.conflicts.push({
            path: conflict.path,
            localContent: conflict.local.content,
            vfsContent: conflict.vfs.content,
            localModified: Date.now(),
            vfsModified: conflict.vfs.modified,
          });
        } else {
          const useLocal = this.config.conflictResolution === 'local' ||
            (this.config.conflictResolution === 'newest' && Date.now() > conflict.vfs.modified);

          if (useLocal) {
            changes.localChanges.push(conflict.local);
          } else {
            changes.vfsChanges.push(conflict.vfs);
          }
        }
      }

      // Sync local → VFS (Chrome only)
      for (const local of changes.localChanges) {
        try {
          await this.syncLocalToVfs(local);
          result.synced++;
          this.updateFileMetadata(local.path, local.hash, 0);
        } catch (error) {
          result.errors.push(`Failed to sync ${local.path}: ${(error as Error).message}`);
        }
      }
    }

    // Sync VFS → local (both browsers)
    for (const vfs of changes.vfsChanges) {
      const syncResult = await this.syncVfsToLocal(vfs);
      if (syncResult.success) {
        result.synced++;
        const path = normalizePath(vfs.domain, vfs.urlPath, vfs.type, vfs.name);
        this.updateFileMetadata(path, computeHash(vfs.content), vfs.version);
      } else {
        result.errors.push(`Failed to sync ${vfs.name}: ${syncResult.error || 'Unknown error'}`);
      }
    }

    return result;
  }

  /**
   * Sync a local file to VFS
   */
  private async syncLocalToVfs(local: LocalFileState): Promise<void> {
    // Parse path to get VFS location
    const parts = this.parseLocalPath(local.path);
    if (!parts) {
      throw new Error('Invalid file path');
    }

    // Send to background to update VFS
    await browser.runtime.sendMessage({
      type: 'SYNC_LOCAL_TO_VFS',
      data: {
        domain: parts.domain,
        urlPath: parts.urlPath,
        fileType: parts.type,
        fileName: parts.name,
        content: local.content,
      },
    });
  }

  /**
   * Sync a VFS file to local
   * @returns DownloadResult for Firefox, or success object for Chrome
   */
  private async syncVfsToLocal(vfs: VfsFileState): Promise<{ success: boolean; error?: string }> {
    const relativePath = normalizePath(vfs.domain, vfs.urlPath, vfs.type, vfs.name);

    if (this.browser === 'chrome' && this.config?.directoryHandle) {
      try {
        await chromeWriter.writeFile(this.config.directoryHandle, relativePath, vfs.content);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Chrome write failed';
        return { success: false, error: errorMessage };
      }
    } else {
      const result: DownloadResult = await firefoxWriter.writeFile(relativePath, vfs.content);
      return { success: result.success, error: result.error };
    }
  }

  /**
   * Handle local file changes
   */
  private handleLocalChanges(changes: LocalFileState[]): void {
    this.setState({ pendingChanges: this.state.pendingChanges + changes.length });

    // Auto-sync if enabled
    if (this.config?.enabled) {
      this.syncNow();
    }
  }

  /**
   * Handle VFS storage changes relayed from background script (Firefox fix).
   * Parses raw storage changes into VfsFileState and triggers sync.
   */
  notifyStorageChanges(changes: Array<{ key: string; newValue?: unknown; oldValue?: unknown }>): void {
    const vfsChanges: VfsFileState[] = [];

    for (const change of changes) {
      if (!change.key.startsWith('vfs:')) continue;

      const domain = change.key.replace('vfs:', '');
      const newValue = change.newValue as any;
      const oldValue = change.oldValue as any;

      if (newValue?.paths) {
        for (const [urlPath, pathData] of Object.entries(newValue.paths as Record<string, any>)) {
          const oldPathData = oldValue?.paths?.[urlPath] as Record<string, any> | undefined;

          // Check scripts
          if (pathData.scripts) {
            for (const [name, file] of Object.entries(pathData.scripts as Record<string, any>)) {
              const oldFile = oldPathData?.scripts?.[name] as { version?: number } | undefined;
              if (!oldFile || oldFile.version !== file.version) {
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
          }

          // Check styles
          if (pathData.styles) {
            for (const [name, file] of Object.entries(pathData.styles as Record<string, any>)) {
              const oldFile = oldPathData?.styles?.[name] as { version?: number } | undefined;
              if (!oldFile || oldFile.version !== file.version) {
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
    }

    if (vfsChanges.length > 0) {
      console.log('[Sync] Syncing', vfsChanges.length, 'file(s)');
      this.handleVfsChanges(vfsChanges);
    }
  }

  /**
   * Handle VFS changes with debouncing
   */
  private async handleVfsChanges(changes: VfsFileState[]): Promise<void> {
    if (!this.config?.enabled || changes.length === 0) {
      return;
    }

    // Accumulate changes for debouncing
    for (const change of changes) {
      // Deduplicate by path - keep latest version
      const path = normalizePath(change.domain, change.urlPath, change.type, change.name);
      const existingIndex = this.pendingVfsChanges.findIndex(
        (c) => normalizePath(c.domain, c.urlPath, c.type, c.name) === path
      );
      if (existingIndex >= 0) {
        this.pendingVfsChanges[existingIndex] = change;
      } else {
        this.pendingVfsChanges.push(change);
      }
    }

    this.setState({ pendingChanges: this.pendingVfsChanges.length });

    // Clear existing debounce timer
    if (this.vfsDebounceTimer) {
      clearTimeout(this.vfsDebounceTimer);
    }

    // Set new debounce timer
    this.vfsDebounceTimer = setTimeout(() => {
      this.processVfsChanges();
    }, this.VFS_DEBOUNCE_MS);
  }

  /**
   * Process accumulated VFS changes after debounce delay
   */
  private async processVfsChanges(): Promise<void> {
    const changesToProcess = [...this.pendingVfsChanges];
    this.pendingVfsChanges = [];
    this.vfsDebounceTimer = null;

    if (changesToProcess.length === 0) {
      return;
    }

    // Firefox: directly export changed files (no local file reading)
    if (this.browser === 'firefox') {
      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      for (const vfs of changesToProcess) {
        const result = await this.syncVfsToLocal(vfs);
        if (result.success) {
          successCount++;
          const path = normalizePath(vfs.domain, vfs.urlPath, vfs.type, vfs.name);
          this.updateFileMetadata(path, computeHash(vfs.content), vfs.version);
        } else {
          errorCount++;
          const errorMsg = `Failed to export ${vfs.name}: ${result.error || 'Unknown error'}`;
          errors.push(errorMsg);
          console.error(`[Sync] ${errorMsg}`);
        }
      }

      await this.saveMetadata();

      // Update state with results
      if (errorCount > 0) {
        this.setState({
          pendingChanges: 0,
          lastSync: Date.now(),
          error: `${errorCount} file(s) failed to sync`,
        });
        this.emit('error', { error: `${errorCount} file(s) failed to sync`, errors });
      } else {
        this.setState({
          pendingChanges: 0,
          lastSync: Date.now(),
          error: null,
        });
      }

      this.emit('sync-complete', {
        success: errorCount === 0,
        synced: successCount,
        conflicts: [],
        errors,
      });
      return;
    }

    // Chrome: full bidirectional sync
    this.syncNow();
  }

  /**
   * Get all VFS files
   */
  private async getVfsFiles(): Promise<VfsFileState[]> {
    const files: VfsFileState[] = [];
    const storage = await browser.storage.local.get(null);

    for (const [key, value] of Object.entries(storage)) {
      if (!key.startsWith('vfs:')) continue;

      const domain = key.replace('vfs:', '');
      const data = value as any;

      if (data?.paths) {
        for (const [urlPath, pathData] of Object.entries(data.paths as Record<string, any>)) {
          if (pathData.scripts) {
            for (const [name, file] of Object.entries(pathData.scripts as Record<string, any>)) {
              files.push({
                domain,
                urlPath,
                type: 'scripts',
                name,
                content: file.content,
                version: file.version || 1,
                modified: file.modified || Date.now(),
              });
            }
          }

          if (pathData.styles) {
            for (const [name, file] of Object.entries(pathData.styles as Record<string, any>)) {
              files.push({
                domain,
                urlPath,
                type: 'styles',
                name,
                content: file.content,
                version: file.version || 1,
                modified: file.modified || Date.now(),
              });
            }
          }
        }
      }
    }

    return files;
  }

  /**
   * Parse local file path to VFS components
   */
  private parseLocalPath(path: string): { domain: string; urlPath: string; type: 'scripts' | 'styles'; name: string } | null {
    // Remove file:// prefix
    const cleanPath = path.replace(/^file:\/\//, '');
    const segments = cleanPath.split('/').filter(Boolean);

    // Find domain segment (contains dot or is localhost)
    let domainIndex = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].includes('.') || segments[i] === 'localhost') {
        domainIndex = i;
        break;
      }
    }

    if (domainIndex === -1) return null;

    const domain = segments[domainIndex];
    const remaining = segments.slice(domainIndex + 1);

    // Find type (scripts or styles)
    const typeIndex = remaining.findIndex(s => s === 'scripts' || s === 'styles');
    if (typeIndex === -1) return null;

    const type = remaining[typeIndex] as 'scripts' | 'styles';
    const urlPath = '/' + remaining.slice(0, typeIndex).join('/');
    const name = remaining.slice(typeIndex + 1).join('/');

    return { domain, urlPath, type, name };
  }

  /**
   * Update file metadata after sync
   */
  private updateFileMetadata(path: string, hash: string, vfsVersion: number): void {
    this.metadata.files[path] = {
      hash,
      vfsVersion,
      localModified: Date.now(),
      lastSync: Date.now(),
    };
  }

  /**
   * Save metadata to storage
   */
  private async saveMetadata(): Promise<void> {
    await browser.storage.local.set({ [SYNC_METADATA_KEY]: this.metadata });
  }

  /**
   * Update state and emit event
   */
  private setState(partial: Partial<SyncState>): void {
    this.state = { ...this.state, ...partial };
    this.emit('status-change', this.state);
  }

  /**
   * Add event listener
   */
  on(event: SyncEventType, callback: SyncEventCallback): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => this.listeners.get(event)?.delete(callback);
  }

  /**
   * Emit event
   */
  private emit(event: SyncEventType, data: any): void {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }

  /**
   * Export all VFS data to local filesystem
   */
  async exportAll(): Promise<void> {
    const vfsFiles = await this.getVfsFiles();

    if (this.browser === 'chrome' && this.config?.directoryHandle) {
      // Write individual files
      for (const file of vfsFiles) {
        const path = `${file.domain}${file.urlPath}/${file.type}/${file.name}`;
        await chromeWriter.writeFile(this.config.directoryHandle, path, file.content);
      }
    } else {
      // Use downloads API
      for (const file of vfsFiles) {
        const path = `${file.domain}${file.urlPath}/${file.type}/${file.name}`;
        await firefoxWriter.writeFile(path, file.content);
      }
    }
  }

  /**
   * Import files from local filesystem to VFS
   */
  async importAll(): Promise<number> {
    if (!this.config?.localPath) {
      throw new Error('No local path configured');
    }

    const files = await listAllFiles(this.config.localPath, ['js', 'css']);
    let imported = 0;

    for (const file of files) {
      try {
        const content = await readLocalFile(file.path);
        const parts = this.parseLocalPath(file.path);

        if (parts) {
          await browser.runtime.sendMessage({
            type: 'SYNC_LOCAL_TO_VFS',
            data: {
              domain: parts.domain,
              urlPath: parts.urlPath,
              fileType: parts.type,
              fileName: parts.name,
              content,
            },
          });
          imported++;
        }
      } catch (error) {
        console.error(`Failed to import ${file.path}:`, error);
      }
    }

    return imported;
  }
}

// Singleton instance
let syncManager: SyncManager | null = null;

export function getSyncManager(): SyncManager {
  if (!syncManager) {
    syncManager = new SyncManager();
  }
  return syncManager;
}

export type { SyncConfig, SyncState, SyncResult, ConflictInfo } from './types';
