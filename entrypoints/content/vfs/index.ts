/**
 * Virtual Filesystem for Page Editor
 *
 * Structure:
 * /{domain}/{url-path}/
 * ├── page.html        # Live DOM as HTML
 * ├── scripts/
 * │   ├── *.js         # User scripts
 * │   └── _auto_edits.js
 * └── styles/
 *     └── *.css        # User styles
 */

import type {
  FileEntry,
  FileContent,
  GrepMatch,
  VFSError,
  ParsedPath,
  FileType,
  EditRecord,
} from './types';
import { PageSync } from './page-sync';
import { VFSStorage } from './storage';

/**
 * Execute JavaScript in the page context via background script.
 * Uses chrome.scripting.executeScript with world: 'MAIN' to bypass CSP.
 */
async function executeInPageContextAsync(code: string): Promise<unknown> {
  // Background script gets tabId from sender
  const response = await browser.runtime.sendMessage({
    type: 'EXECUTE_IN_MAIN_WORLD',
    code,
  }) as { success: boolean; result?: unknown; error?: string };

  if (!response.success) {
    throw new Error(response.error || 'Script execution failed');
  }

  return response.result;
}

/**
 * Synchronous wrapper - fires async execution, doesn't wait for result.
 */
function executeInPageContext(code: string): unknown {
  // Fire and forget - we can't make this truly synchronous
  executeInPageContextAsync(code).catch(err => {
    console.error('[VFS] Script execution error:', err);
  });
  return undefined;
}

/**
 * Execute JavaScript in the page context (fire and forget, no result).
 */
function executeInPageContextNoResult(code: string): void {
  executeInPageContextAsync(code).catch(err => {
    console.error('[VFS] Script execution error:', err);
  });
}

export class VirtualFS {
  private pageSync: PageSync;
  private storage: VFSStorage;
  private domain: string;
  private urlPath: string;

  constructor() {
    const url = new URL(window.location.href);
    this.domain = url.hostname;
    this.urlPath = url.pathname;
    this.pageSync = new PageSync();
    this.storage = new VFSStorage(this.domain, this.urlPath);
  }

  /**
   * Get the current working directory (domain + path)
   */
  getCwd(): string {
    return `/${this.domain}${this.urlPath}`;
  }

  /**
   * Parse a VFS path into components
   */
  parsePath(path: string): ParsedPath | null {
    // Normalize path
    let normalizedPath = path;

    // Handle relative paths
    if (path.startsWith('./') || path.startsWith('../')) {
      normalizedPath = this.resolvePath(path);
    }

    // Ensure path starts with /
    if (!normalizedPath.startsWith('/')) {
      normalizedPath = `/${this.domain}${this.urlPath}/${normalizedPath}`;
    }

    // Parse: /{domain}/{url-path}/[page.html|scripts/name.js|styles/name.css]
    const match = normalizedPath.match(/^\/([^\/]+)(\/[^\/]*)*\/(page\.html|scripts\/([^\/]+\.js)|styles\/([^\/]+\.css))$/);

    if (!match) {
      // Check if it's a directory path
      const dirMatch = normalizedPath.match(/^\/([^\/]+)(\/.*)?$/);
      if (dirMatch) {
        return {
          domain: dirMatch[1],
          urlPath: dirMatch[2] || '/',
          fileType: 'page' as FileType, // Default
          fileName: '',
          fullPath: normalizedPath,
        };
      }
      return null;
    }

    const domain = match[1];
    const urlPathParts = normalizedPath.replace(`/${domain}`, '').replace(/\/(page\.html|scripts\/.*|styles\/.*)$/, '');
    const urlPath = urlPathParts || '/';

    let fileType: FileType = 'page';
    let fileName = '';

    if (match[3] === 'page.html') {
      fileType = 'page';
      fileName = 'page.html';
    } else if (match[4]) {
      fileType = 'script';
      fileName = match[4];
    } else if (match[5]) {
      fileType = 'style';
      fileName = match[5];
    }

    return {
      domain,
      urlPath,
      fileType,
      fileName,
      fullPath: normalizedPath,
    };
  }

  /**
   * Resolve relative path to absolute
   */
  resolvePath(relativePath: string): string {
    const base = `/${this.domain}${this.urlPath}`;
    const parts = base.split('/').filter(Boolean);

    const relParts = relativePath.split('/');
    for (const part of relParts) {
      if (part === '..') {
        parts.pop();
      } else if (part !== '.' && part !== '') {
        parts.push(part);
      }
    }

    return '/' + parts.join('/');
  }

  /**
   * Read a file
   */
  async read(path: string, offset?: number, limit?: number): Promise<FileContent | VFSError> {
    const parsed = this.parsePath(path);
    if (!parsed) {
      return {
        code: 'INVALID_PATH',
        message: `Invalid path: ${path}`,
        path,
      };
    }

    // Check if path matches current domain
    if (parsed.domain !== this.domain) {
      return {
        code: 'PERMISSION_DENIED',
        message: `Cannot access files from different domain: ${parsed.domain}`,
        path,
      };
    }

    if (parsed.fileType === 'page') {
      return this.pageSync.read(offset, limit);
    }

    // Read from storage
    const file = await this.storage.readFile(parsed.fileType, parsed.fileName, parsed.urlPath);
    if (!file) {
      return {
        code: 'NOT_FOUND',
        message: `File not found: ${path}`,
        path,
      };
    }

    let content = file.content;
    const lines = content.split('\n');
    const totalLines = lines.length;

    // Apply offset and limit
    if (offset !== undefined || limit !== undefined) {
      const start = offset || 0;
      const end = limit ? start + limit : undefined;
      content = lines.slice(start, end).join('\n');
    }

    return {
      content,
      version: file.version,
      lines: totalLines,
      path: parsed.fullPath,
    };
  }

  /**
   * Write a file (requires expectedVersion)
   */
  async write(
    path: string,
    content: string,
    expectedVersion: number
  ): Promise<{ success: true; version: number } | VFSError> {
    const parsed = this.parsePath(path);
    if (!parsed) {
      return {
        code: 'INVALID_PATH',
        message: `Invalid path: ${path}`,
        path,
      };
    }

    if (parsed.domain !== this.domain) {
      return {
        code: 'PERMISSION_DENIED',
        message: `Cannot write to different domain: ${parsed.domain}`,
        path,
      };
    }

    if (parsed.fileType === 'page') {
      return this.pageSync.write(content, expectedVersion);
    }

    // Write to storage
    const result = await this.storage.writeFile(
      parsed.fileType,
      parsed.fileName,
      content,
      expectedVersion,
      parsed.urlPath
    );

    if ('code' in result) {
      return result;
    }

    // If it's a style file, inject it
    if (parsed.fileType === 'style') {
      this.injectStyle(parsed.fileName, content);
    }

    return result;
  }

  /**
   * Edit a file (find and replace)
   */
  async edit(
    path: string,
    oldString: string,
    newString: string,
    expectedVersion: number,
    replaceAll = false
  ): Promise<{ success: true; version: number; replacements: number } | VFSError> {
    const parsed = this.parsePath(path);
    if (!parsed) {
      return {
        code: 'INVALID_PATH',
        message: `Invalid path: ${path}`,
        path,
      };
    }

    if (parsed.domain !== this.domain) {
      return {
        code: 'PERMISSION_DENIED',
        message: `Cannot edit files from different domain: ${parsed.domain}`,
        path,
      };
    }

    if (parsed.fileType === 'page') {
      return this.pageSync.edit(oldString, newString, expectedVersion, replaceAll);
    }

    // Read current content
    const file = await this.storage.readFile(parsed.fileType, parsed.fileName, parsed.urlPath);
    if (!file) {
      return {
        code: 'NOT_FOUND',
        message: `File not found: ${path}`,
        path,
      };
    }

    // Check version
    if (file.version !== expectedVersion) {
      return {
        code: 'VERSION_MISMATCH',
        message: `File changed since last read (v${expectedVersion} → v${file.version}). Re-read required.`,
        path,
        expectedVersion,
        actualVersion: file.version,
      };
    }

    // Check if oldString exists
    if (!file.content.includes(oldString)) {
      return {
        code: 'NOT_FOUND',
        message: `String not found in file: "${oldString.slice(0, 50)}..."`,
        path,
      };
    }

    // Perform replacement
    let newContent: string;
    let replacements = 0;

    if (replaceAll) {
      const parts = file.content.split(oldString);
      replacements = parts.length - 1;
      newContent = parts.join(newString);
    } else {
      newContent = file.content.replace(oldString, newString);
      replacements = 1;
    }

    // Write back
    const writeResult = await this.storage.writeFile(
      parsed.fileType,
      parsed.fileName,
      newContent,
      expectedVersion,
      parsed.urlPath
    );

    if ('code' in writeResult) {
      return writeResult;
    }

    // If it's a style file, re-inject it
    if (parsed.fileType === 'style') {
      this.injectStyle(parsed.fileName, newContent);
    }

    return {
      success: true,
      version: writeResult.version,
      replacements,
    };
  }

  /**
   * List directory contents
   */
  async ls(path?: string): Promise<FileEntry[]> {
    const targetPath = path || this.getCwd();
    const parsed = this.parsePath(targetPath);

    if (!parsed || parsed.domain !== this.domain) {
      return [];
    }

    const entries: FileEntry[] = [];

    // Always show page.html
    entries.push({
      name: 'page.html',
      path: `${targetPath}/page.html`,
      type: 'file',
      version: this.pageSync.getVersion(),
    });

    // Show scripts directory
    entries.push({
      name: 'scripts',
      path: `${targetPath}/scripts`,
      type: 'directory',
    });

    // Show styles directory
    entries.push({
      name: 'styles',
      path: `${targetPath}/styles`,
      type: 'directory',
    });

    // If path ends with /scripts or /styles, list those files
    if (targetPath.endsWith('/scripts')) {
      // Strip /scripts suffix to get the base URL path where files are stored
      const baseUrlPath = parsed.urlPath.replace(/\/scripts$/, '') || '/';
      const scripts = await this.storage.listFiles('script', baseUrlPath);
      for (const script of scripts) {
        entries.push({
          name: script.name,
          path: `${targetPath}/${script.name}`,
          type: 'file',
          version: script.version,
          modified: script.modified,
        });
      }
    } else if (targetPath.endsWith('/styles')) {
      // Strip /styles suffix to get the base URL path where files are stored
      const baseUrlPath = parsed.urlPath.replace(/\/styles$/, '') || '/';
      const styles = await this.storage.listFiles('style', baseUrlPath);
      for (const style of styles) {
        entries.push({
          name: style.name,
          path: `${targetPath}/${style.name}`,
          type: 'file',
          version: style.version,
          modified: style.modified,
        });
      }
    }

    return entries;
  }

  /**
   * Find files matching a glob pattern
   */
  async glob(pattern: string): Promise<string[]> {
    const matches: string[] = [];
    const cwd = this.getCwd();

    // Simple glob implementation
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);

    // Check page.html
    if (regex.test(`${cwd}/page.html`)) {
      matches.push(`${cwd}/page.html`);
    }

    // Check scripts
    const scripts = await this.storage.listFiles('script', this.urlPath);
    for (const script of scripts) {
      const scriptPath = `${cwd}/scripts/${script.name}`;
      if (regex.test(scriptPath)) {
        matches.push(scriptPath);
      }
    }

    // Check styles
    const styles = await this.storage.listFiles('style', this.urlPath);
    for (const style of styles) {
      const stylePath = `${cwd}/styles/${style.name}`;
      if (regex.test(stylePath)) {
        matches.push(stylePath);
      }
    }

    return matches;
  }

  /**
   * Search for pattern in files
   */
  async grep(pattern: string, path?: string, contextLines = 2): Promise<GrepMatch[]> {
    const matches: GrepMatch[] = [];
    const cwd = this.getCwd();

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'gi');
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    // Determine which files to search
    const filesToSearch: string[] = [];

    if (path) {
      const parsed = this.parsePath(path);
      if (parsed && parsed.fileName) {
        filesToSearch.push(path);
      } else {
        // Search all files in directory
        if (path.endsWith('/scripts')) {
          const scripts = await this.storage.listFiles('script', this.urlPath);
          scripts.forEach(s => filesToSearch.push(`${cwd}/scripts/${s.name}`));
        } else if (path.endsWith('/styles')) {
          const styles = await this.storage.listFiles('style', this.urlPath);
          styles.forEach(s => filesToSearch.push(`${cwd}/styles/${s.name}`));
        } else {
          filesToSearch.push(`${cwd}/page.html`);
        }
      }
    } else {
      // Search page.html by default
      filesToSearch.push(`${cwd}/page.html`);
    }

    // Search each file
    for (const filePath of filesToSearch) {
      const result = await this.read(filePath);
      if ('code' in result) continue;

      const lines = result.content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        const lineMatch = regex.exec(lines[i]);

        if (lineMatch) {
          // Get context
          const contextStart = Math.max(0, i - contextLines);
          const contextEnd = Math.min(lines.length, i + contextLines + 1);
          const context = lines.slice(contextStart, contextEnd).join('\n');

          matches.push({
            path: filePath,
            line: i + 1,
            content: lines[i],
            match: lineMatch[0],
            context,
          });
        }
      }
    }

    return matches;
  }

  /**
   * Execute a script file
   */
  async exec(scriptPath: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    // If starts with ./, resolve to scripts directory
    let resolvedPath = scriptPath;
    if (scriptPath.startsWith('./')) {
      resolvedPath = `${this.getCwd()}/scripts/${scriptPath.slice(2)}`;
    }

    const result = await this.read(resolvedPath);
    if ('code' in result) {
      return {
        success: false,
        error: result.message,
      };
    }

    try {
      // Execute the script via script tag injection (bypasses CSP)
      const execResult = executeInPageContext(result.content);
      return {
        success: true,
        result: execResult,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Record an edit for auto-persistence
   */
  async recordEdit(selector: string, oldContent: string, newContent: string): Promise<void> {
    await this.storage.addEditRecord(this.urlPath, {
      selector,
      oldContent,
      newContent,
      timestamp: Date.now(),
    });

    // Regenerate _auto_edits.js
    await this.generateAutoEditsScript();
  }

  /**
   * Generate _auto_edits.js from recorded edits
   */
  private async generateAutoEditsScript(): Promise<void> {
    const records = await this.storage.getEditRecords(this.urlPath);
    if (records.length === 0) return;

    let script = '// Auto-generated script to replay page edits\n';
    script += '(function() {\n';

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const escapedOld = JSON.stringify(record.oldContent);
      const escapedNew = JSON.stringify(record.newContent);
      const escapedSelector = JSON.stringify(record.selector);

      script += `  // Edit ${i + 1}\n`;
      script += `  const el${i} = document.querySelector(${escapedSelector});\n`;
      script += `  if (el${i}) {\n`;
      script += `    const html = el${i}.innerHTML;\n`;
      script += `    if (html.includes(${escapedOld})) {\n`;
      script += `      el${i}.innerHTML = html.replace(${escapedOld}, ${escapedNew});\n`;
      script += `    }\n`;
      script += `  }\n\n`;
    }

    script += '})();\n';

    // Save the auto-edits script
    await this.storage.writeFile('script', '_auto_edits.js', script, 0, this.urlPath);
  }

  /**
   * Run all saved scripts and styles on page load
   */
  async runAutoEdits(): Promise<void> {
    console.log('[VFS] Loading saved styles for:', this.urlPath);
    // Note: Scripts are handled by userScripts API (registered in background.js)
    // This only injects styles since CSS injection works fine from content scripts

    // Inject all saved styles
    const styles = await this.storage.listFiles('style', this.urlPath);
    console.log('[VFS] Found styles:', styles.map(s => s.name));

    for (const style of styles) {
      const file = await this.storage.readFile('style', style.name, this.urlPath);
      if (file) {
        this.injectStyle(style.name, file.content);
        console.log('[VFS] Injected style:', style.name);
      }
    }
  }

  /**
   * List all scripts for current URL path
   */
  async listScripts(): Promise<Array<{ name: string; version: number; modified: number }>> {
    return this.storage.listFiles('script', this.urlPath);
  }

  /**
   * List all styles for current URL path
   */
  async listStyles(): Promise<Array<{ name: string; version: number; modified: number }>> {
    return this.storage.listFiles('style', this.urlPath);
  }

  /**
   * Invalidate storage cache (call after external changes like import)
   */
  invalidateCache(): void {
    this.storage.invalidateCache();
  }

  /**
   * Delete a file
   */
  async deleteFile(type: 'script' | 'style', name: string): Promise<boolean> {
    const success = await this.storage.deleteFile(type, name, this.urlPath);

    // If it's a style, also remove from DOM
    if (success && type === 'style') {
      const styleId = `vfs-style-${name.replace(/[^a-z0-9]/gi, '-')}`;
      const existing = document.getElementById(styleId);
      if (existing) {
        existing.remove();
      }
    }

    return success;
  }

  /**
   * Inject a style into the page
   */
  private injectStyle(name: string, content: string): void {
    const styleId = `vfs-style-${name.replace(/[^a-z0-9]/gi, '-')}`;

    // Remove existing style with same ID
    const existing = document.getElementById(styleId);
    if (existing) {
      existing.remove();
    }

    // Inject new style
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = content;
    document.head.appendChild(style);
  }
}

// Singleton instance
let vfsInstance: VirtualFS | null = null;

export function getVFS(): VirtualFS {
  if (!vfsInstance) {
    vfsInstance = new VirtualFS();
  }
  return vfsInstance;
}

export { executeInPageContext };

export * from './types';
