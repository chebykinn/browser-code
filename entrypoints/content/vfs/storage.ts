/**
 * VFS Storage - Persistent storage for scripts and styles
 *
 * Storage structure:
 * vfs:{domain} -> {
 *   paths: {
 *     "/path": {
 *       scripts: { "name.js": { content, version, created, modified } },
 *       styles: { "name.css": { content, version, created, modified } },
 *       editRecords: [{ selector, oldContent, newContent, timestamp }]
 *     }
 *   }
 * }
 */

import type { StoredFile, DomainStorage, EditRecord, VFSError, FileType, FileListResult, FileReadResult } from './types';
import { findMatchingRoutes, type RouteMatch } from './route-matcher';

/**
 * Normalize a URL path by removing trailing slashes (except for root "/")
 */
function normalizePath(path: string): string {
  if (path === '/' || path === '') return '/';
  return path.replace(/\/+$/, '');
}

export interface StoredScreenshot {
  dataUrl: string;
  version: number;
  timestamp: number;
  format: 'png' | 'jpeg';
}

// In-memory screenshot storage (per URL path, not persisted)
const screenshotCache = new Map<string, StoredScreenshot>();

export class VFSStorage {
  private domain: string;
  private defaultUrlPath: string;
  private storageKey: string;
  private cache: DomainStorage | null = null;

  constructor(domain: string, urlPath: string) {
    this.domain = domain;
    this.defaultUrlPath = normalizePath(urlPath);
    this.storageKey = `vfs:${domain}`;
  }

  /**
   * Load storage data
   */
  private async load(): Promise<DomainStorage> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const result = await browser.storage.local.get(this.storageKey);
      const stored = result[this.storageKey] as DomainStorage | undefined;
      this.cache = stored && stored.paths ? stored : { paths: {} };
      console.log('[VFS Storage] Loaded:', this.storageKey, this.cache);
      return this.cache;
    } catch (error) {
      console.error('[VFS Storage] Load failed:', error);
      this.cache = { paths: {} };
      return this.cache;
    }
  }

  /**
   * Invalidate cache to force reload from storage
   */
  invalidateCache(): void {
    console.log('[VFS Storage] Cache invalidated');
    this.cache = null;
  }

  /**
   * Save storage data
   */
  private async save(): Promise<void> {
    if (!this.cache) return;

    try {
      await browser.storage.local.set({ [this.storageKey]: this.cache });
      console.log('[VFS Storage] Saved:', this.storageKey, this.cache);
    } catch (error) {
      console.error('[VFS Storage] Save failed:', error);
    }
  }

  /**
   * Ensure path exists in storage
   */
  private ensurePath(data: DomainStorage, urlPath: string): void {
    if (!data.paths[urlPath]) {
      data.paths[urlPath] = {
        scripts: {},
        styles: {},
        editRecords: [],
      };
    }
  }

  /**
   * Read a file from storage with dynamic route matching support.
   * First tries exact match, then falls back to pattern matching.
   */
  async readFile(
    type: FileType,
    name: string,
    urlPath?: string
  ): Promise<FileReadResult> {
    const data = await this.load();
    const targetPath = normalizePath(urlPath || this.defaultUrlPath);

    // First try exact match
    if (data.paths[targetPath]) {
      const collection = type === 'script' ? data.paths[targetPath].scripts : data.paths[targetPath].styles;
      return {
        file: collection[name] || null,
        matchedPattern: null,
        params: {},
      };
    }

    // Try dynamic route matching
    const matches = await this.findMatchingPaths(targetPath);

    if (matches.length > 0) {
      const bestMatch = matches[0];
      const pathData = data.paths[bestMatch.pattern];
      const collection = type === 'script' ? pathData.scripts : pathData.styles;
      return {
        file: collection[name] || null,
        matchedPattern: bestMatch.pattern,
        params: bestMatch.params,
      };
    }

    return { file: null, matchedPattern: null, params: {} };
  }

  /**
   * Read a file from storage (simple version for backwards compatibility)
   */
  async readFileSimple(
    type: FileType,
    name: string,
    urlPath?: string
  ): Promise<StoredFile | null> {
    const result = await this.readFile(type, name, urlPath);
    return result.file;
  }

  /**
   * Write a file to storage
   */
  async writeFile(
    type: FileType,
    name: string,
    content: string,
    expectedVersion: number,
    urlPath?: string
  ): Promise<{ success: true; version: number } | VFSError> {
    const data = await this.load();
    const path = normalizePath(urlPath || this.defaultUrlPath);

    this.ensurePath(data, path);

    const collection = type === 'script' ? data.paths[path].scripts : data.paths[path].styles;
    const existing = collection[name];

    // Check version (0 means new file)
    if (expectedVersion !== 0 && existing && existing.version !== expectedVersion) {
      return {
        code: 'VERSION_MISMATCH',
        message: `File changed since last read (v${expectedVersion} → v${existing.version}). Re-read required.`,
        path: `${path}/${type}s/${name}`,
        expectedVersion,
        actualVersion: existing.version,
      };
    }

    const now = Date.now();
    const newVersion = existing ? existing.version + 1 : 1;

    collection[name] = {
      content,
      version: newVersion,
      created: existing?.created || now,
      modified: now,
    };

    await this.save();

    return {
      success: true,
      version: newVersion,
    };
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(type: FileType, name: string, urlPath?: string): Promise<boolean> {
    const data = await this.load();
    const path = normalizePath(urlPath || this.defaultUrlPath);

    if (!data.paths[path]) {
      return false;
    }

    const collection = type === 'script' ? data.paths[path].scripts : data.paths[path].styles;

    if (!collection[name]) {
      return false;
    }

    delete collection[name];
    await this.save();

    return true;
  }

  /**
   * Find all stored paths that match the given URL path using dynamic route matching.
   * Returns matches sorted by priority (most specific first).
   */
  async findMatchingPaths(urlPath: string): Promise<RouteMatch[]> {
    const data = await this.load();
    const storedPaths = Object.keys(data.paths);
    return findMatchingRoutes(normalizePath(urlPath), storedPaths);
  }

  /**
   * List files in a directory with dynamic route matching support.
   * First tries exact match, then falls back to pattern matching.
   */
  async listFiles(
    type: FileType,
    urlPath?: string
  ): Promise<FileListResult> {
    const data = await this.load();
    const targetPath = normalizePath(urlPath || this.defaultUrlPath);

    // First try exact match (backwards compatible)
    if (data.paths[targetPath]) {
      const collection = type === 'script' ? data.paths[targetPath].scripts : data.paths[targetPath].styles;

      return {
        files: Object.entries(collection).map(([name, file]) => ({
          name,
          version: file.version,
          modified: file.modified,
        })),
        matchedPattern: null,
        params: {},
      };
    }

    // Try dynamic route matching
    const matches = await this.findMatchingPaths(targetPath);

    if (matches.length > 0) {
      // Use highest priority match
      const bestMatch = matches[0];
      const pathData = data.paths[bestMatch.pattern];
      const collection = type === 'script' ? pathData.scripts : pathData.styles;

      return {
        files: Object.entries(collection).map(([name, file]) => ({
          name,
          version: file.version,
          modified: file.modified,
        })),
        matchedPattern: bestMatch.pattern,
        params: bestMatch.params,
      };
    }

    return { files: [], matchedPattern: null, params: {} };
  }

  /**
   * List files in a directory (simple version for backwards compatibility)
   */
  async listFilesSimple(
    type: FileType,
    urlPath?: string
  ): Promise<Array<{ name: string; version: number; modified: number }>> {
    const result = await this.listFiles(type, urlPath);
    return result.files;
  }

  /**
   * Add an edit record for auto-persistence
   */
  async addEditRecord(urlPath: string, record: EditRecord): Promise<void> {
    const data = await this.load();
    const path = normalizePath(urlPath);
    this.ensurePath(data, path);

    // Check if we already have a similar edit (same selector and oldContent)
    const existing = data.paths[path].editRecords.findIndex(
      r => r.selector === record.selector && r.oldContent === record.oldContent
    );

    if (existing >= 0) {
      // Update existing record
      data.paths[path].editRecords[existing] = record;
    } else {
      // Add new record
      data.paths[path].editRecords.push(record);
    }

    await this.save();
  }

  /**
   * Get all edit records for a path
   */
  async getEditRecords(urlPath: string): Promise<EditRecord[]> {
    const data = await this.load();
    const path = normalizePath(urlPath);

    if (!data.paths[path]) {
      return [];
    }

    return data.paths[path].editRecords || [];
  }

  /**
   * Clear edit records for a path
   */
  async clearEditRecords(urlPath: string): Promise<void> {
    const data = await this.load();
    const path = normalizePath(urlPath);

    if (data.paths[path]) {
      data.paths[path].editRecords = [];
      await this.save();
    }
  }

  /**
   * Check if any files exist for a domain
   */
  async hasFiles(): Promise<boolean> {
    const data = await this.load();
    return Object.keys(data.paths).length > 0;
  }

  /**
   * Get all paths with files for this domain
   */
  async getAllPaths(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data.paths);
  }

  /**
   * Save a screenshot (in-memory only, not persisted)
   */
  saveScreenshot(urlPath: string, dataUrl: string, format: 'png' | 'jpeg'): StoredScreenshot {
    const key = `${this.domain}:${normalizePath(urlPath)}`;
    const existing = screenshotCache.get(key);
    const screenshot: StoredScreenshot = {
      dataUrl,
      version: existing ? existing.version + 1 : 1,
      timestamp: Date.now(),
      format,
    };
    screenshotCache.set(key, screenshot);
    console.log('[VFS Storage] Screenshot saved for:', key);
    return screenshot;
  }

  /**
   * Get the latest screenshot (in-memory)
   */
  getScreenshot(urlPath: string): StoredScreenshot | null {
    const key = `${this.domain}:${normalizePath(urlPath)}`;
    return screenshotCache.get(key) || null;
  }
}
