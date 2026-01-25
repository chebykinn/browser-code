/**
 * Sync module types
 */

export interface SyncConfig {
  enabled: boolean;
  localPath: string; // file:// URL to watch
  syncInterval: number; // ms between polls
  conflictResolution: 'newest' | 'vfs' | 'local' | 'ask';
  // Chrome-specific
  directoryHandle?: FileSystemDirectoryHandle;
}

export interface SyncMetadata {
  version: 1;
  lastSync: number;
  files: Record<string, FileMetadata>;
}

export interface FileMetadata {
  hash: string;
  vfsVersion: number;
  localModified: number;
  lastSync: number;
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disabled';

export interface SyncState {
  status: SyncStatus;
  lastSync: number | null;
  pendingChanges: number;
  error: string | null;
}

export type SyncDirection = 'local-to-vfs' | 'vfs-to-local' | 'conflict';

export interface SyncChange {
  path: string;
  direction: SyncDirection;
  content?: string;
  localModified?: number;
  vfsVersion?: number;
}

export interface ConflictInfo {
  path: string;
  localContent: string;
  vfsContent: string;
  localModified: number;
  vfsModified: number;
}

export interface SyncResult {
  success: boolean;
  synced: number;
  conflicts: ConflictInfo[];
  errors: string[];
}

// Browser detection
export type BrowserType = 'chrome' | 'firefox' | 'unknown';

export function detectBrowser(): BrowserType {
  // In WXT, the browser global is always available
  // Check for Firefox-specific APIs
  if (typeof browser !== 'undefined') {
    // Firefox has getBrowserInfo, Chrome doesn't
    if ('getBrowserInfo' in browser.runtime) {
      return 'firefox';
    }
    return 'chrome';
  }
  return 'unknown';
}

// Check if File System Access API is available
export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}
