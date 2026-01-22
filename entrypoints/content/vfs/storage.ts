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

import type { StoredFile, DomainStorage, EditRecord, VFSError, FileType } from './types';

export class VFSStorage {
  private domain: string;
  private defaultUrlPath: string;
  private storageKey: string;
  private cache: DomainStorage | null = null;

  constructor(domain: string, urlPath: string) {
    this.domain = domain;
    this.defaultUrlPath = urlPath;
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
   * Read a file from storage
   */
  async readFile(
    type: FileType,
    name: string,
    urlPath?: string
  ): Promise<StoredFile | null> {
    const data = await this.load();
    const path = urlPath || this.defaultUrlPath;

    if (!data.paths[path]) {
      return null;
    }

    const collection = type === 'script' ? data.paths[path].scripts : data.paths[path].styles;
    return collection[name] || null;
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
    const path = urlPath || this.defaultUrlPath;

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
    const path = urlPath || this.defaultUrlPath;

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
   * List files in a directory
   */
  async listFiles(
    type: FileType,
    urlPath?: string
  ): Promise<Array<{ name: string; version: number; modified: number }>> {
    const data = await this.load();
    const path = urlPath || this.defaultUrlPath;

    if (!data.paths[path]) {
      return [];
    }

    const collection = type === 'script' ? data.paths[path].scripts : data.paths[path].styles;

    return Object.entries(collection).map(([name, file]) => ({
      name,
      version: file.version,
      modified: file.modified,
    }));
  }

  /**
   * Add an edit record for auto-persistence
   */
  async addEditRecord(urlPath: string, record: EditRecord): Promise<void> {
    const data = await this.load();
    this.ensurePath(data, urlPath);

    // Check if we already have a similar edit (same selector and oldContent)
    const existing = data.paths[urlPath].editRecords.findIndex(
      r => r.selector === record.selector && r.oldContent === record.oldContent
    );

    if (existing >= 0) {
      // Update existing record
      data.paths[urlPath].editRecords[existing] = record;
    } else {
      // Add new record
      data.paths[urlPath].editRecords.push(record);
    }

    await this.save();
  }

  /**
   * Get all edit records for a path
   */
  async getEditRecords(urlPath: string): Promise<EditRecord[]> {
    const data = await this.load();

    if (!data.paths[urlPath]) {
      return [];
    }

    return data.paths[urlPath].editRecords || [];
  }

  /**
   * Clear edit records for a path
   */
  async clearEditRecords(urlPath: string): Promise<void> {
    const data = await this.load();

    if (data.paths[urlPath]) {
      data.paths[urlPath].editRecords = [];
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
}
