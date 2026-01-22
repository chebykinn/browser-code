/**
 * Page Sync - Handles DOM ↔ page.html synchronization
 */

import type { FileContent, VFSError } from './types';

export class PageSync {
  private version: number = 1;
  private lastContent: string = '';

  constructor() {
    // Initialize with current DOM
    this.lastContent = this.getDomHtml();

    // Watch for DOM changes to update version
    this.setupMutationObserver();
  }

  /**
   * Get current page version
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Get DOM as HTML string
   */
  private getDomHtml(): string {
    return document.documentElement.outerHTML;
  }

  /**
   * Get DOM as formatted HTML (for grep/read display)
   */
  getFormattedHtml(): string {
    const html = document.documentElement.outerHTML;
    // Add newlines between tags for better readability
    return html
      .replace(/></g, '>\n<')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');
  }

  /**
   * Setup mutation observer to track DOM changes
   */
  private setupMutationObserver(): void {
    const observer = new MutationObserver(() => {
      const currentHtml = this.getDomHtml();
      if (currentHtml !== this.lastContent) {
        this.version++;
        this.lastContent = currentHtml;
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
  }

  /**
   * Read page.html (returns formatted DOM for readability)
   */
  read(offset?: number, limit?: number): FileContent {
    // Use formatted HTML for better readability in read/grep
    const html = this.getFormattedHtml();
    const lines = html.split('\n');
    const totalLines = lines.length;

    let content = html;
    if (offset !== undefined || limit !== undefined) {
      const start = offset || 0;
      const end = limit ? start + limit : undefined;
      content = lines.slice(start, end).join('\n');
    }

    return {
      content,
      version: this.version,
      lines: totalLines,
      path: `/${window.location.hostname}${window.location.pathname}/page.html`,
    };
  }

  /**
   * Write to page.html (updates DOM)
   */
  write(
    content: string,
    expectedVersion: number
  ): { success: true; version: number } | VFSError {
    // Check version
    if (this.version !== expectedVersion) {
      return {
        code: 'VERSION_MISMATCH',
        message: `Page changed since last read (v${expectedVersion} → v${this.version}). Re-read required.`,
        path: 'page.html',
        expectedVersion,
        actualVersion: this.version,
      };
    }

    try {
      // Parse the new HTML
      const parser = new DOMParser();
      const newDoc = parser.parseFromString(content, 'text/html');

      // Replace document content
      // Note: We can't replace the entire document easily, so we replace head and body
      document.head.innerHTML = newDoc.head.innerHTML;
      document.body.innerHTML = newDoc.body.innerHTML;

      // Copy attributes from html element
      const newHtml = newDoc.documentElement;
      const currentHtml = document.documentElement;
      for (const attr of Array.from(newHtml.attributes)) {
        currentHtml.setAttribute(attr.name, attr.value);
      }

      // Update version and cache
      this.version++;
      this.lastContent = this.getDomHtml();

      return {
        success: true,
        version: this.version,
      };
    } catch (error) {
      return {
        code: 'INVALID_PATH',
        message: `Failed to update page: ${error instanceof Error ? error.message : String(error)}`,
        path: 'page.html',
      };
    }
  }

  /**
   * Edit page.html (find and replace in DOM)
   */
  edit(
    oldString: string,
    newString: string,
    expectedVersion: number,
    replaceAll = false
  ): { success: true; version: number; replacements: number; selector?: string } | VFSError {
    // Check version
    if (this.version !== expectedVersion) {
      return {
        code: 'VERSION_MISMATCH',
        message: `Page changed since last read (v${expectedVersion} → v${this.version}). Re-read required.`,
        path: 'page.html',
        expectedVersion,
        actualVersion: this.version,
      };
    }

    // Normalize the search string (remove extra whitespace/newlines from formatted HTML)
    const normalizedOld = oldString.replace(/\s+/g, ' ').trim();
    const normalizedNew = newString.replace(/\s+/g, ' ').trim();

    // Check both raw and formatted HTML
    const rawHtml = this.getDomHtml();
    const formattedHtml = this.getFormattedHtml();

    // Try to find in formatted HTML first (what agent sees)
    const inFormatted = formattedHtml.includes(oldString);
    const inRaw = rawHtml.includes(oldString);
    const inNormalized = rawHtml.replace(/\s+/g, ' ').includes(normalizedOld);

    if (!inFormatted && !inRaw && !inNormalized) {
      return {
        code: 'NOT_FOUND',
        message: `String not found in page: "${oldString.slice(0, 50)}..."`,
        path: 'page.html',
      };
    }

    // Use the appropriate search string
    const searchString = inRaw ? oldString : normalizedOld;
    const replaceString = inRaw ? newString : normalizedNew;

    // Try to find the element containing the string for better targeting
    const element = this.findElementContaining(searchString);
    let selector: string | undefined;
    let replacements = 0;

    if (element) {
      // Edit specific element
      selector = this.getSelector(element);
      const originalHtml = element.innerHTML;
      const normalizedElementHtml = originalHtml.replace(/\s+/g, ' ');

      if (replaceAll) {
        // Try exact match first, then normalized
        if (originalHtml.includes(searchString)) {
          const parts = originalHtml.split(searchString);
          replacements = parts.length - 1;
          element.innerHTML = parts.join(replaceString);
        } else if (normalizedElementHtml.includes(searchString)) {
          // Use regex for whitespace-flexible replacement
          const regex = new RegExp(searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'g');
          const matches = originalHtml.match(regex);
          replacements = matches ? matches.length : 0;
          element.innerHTML = originalHtml.replace(regex, replaceString);
        }
      } else {
        if (originalHtml.includes(searchString)) {
          element.innerHTML = originalHtml.replace(searchString, replaceString);
          replacements = 1;
        } else {
          const regex = new RegExp(searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
          element.innerHTML = originalHtml.replace(regex, replaceString);
          replacements = 1;
        }
      }
    } else {
      // Fall back to editing body
      const originalHtml = document.body.innerHTML;
      const normalizedBodyHtml = originalHtml.replace(/\s+/g, ' ');

      if (replaceAll) {
        if (originalHtml.includes(searchString)) {
          const parts = originalHtml.split(searchString);
          replacements = parts.length - 1;
          document.body.innerHTML = parts.join(replaceString);
        } else if (normalizedBodyHtml.includes(searchString)) {
          const regex = new RegExp(searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'), 'g');
          const matches = originalHtml.match(regex);
          replacements = matches ? matches.length : 0;
          document.body.innerHTML = originalHtml.replace(regex, replaceString);
        }
      } else {
        if (originalHtml.includes(searchString)) {
          document.body.innerHTML = originalHtml.replace(searchString, replaceString);
          replacements = 1;
        } else {
          const regex = new RegExp(searchString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
          document.body.innerHTML = originalHtml.replace(regex, replaceString);
          replacements = 1;
        }
      }
    }

    // Update version and cache
    this.version++;
    this.lastContent = this.getDomHtml();

    return {
      success: true,
      version: this.version,
      replacements,
      selector,
    };
  }

  /**
   * Find the most specific element containing the search string
   */
  private findElementContaining(searchString: string): Element | null {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.includes(searchString)) {
        return node.parentElement;
      }
    }

    // Check innerHTML of elements
    const elements = document.body.querySelectorAll('*');
    for (const el of elements) {
      if (el.innerHTML.includes(searchString) && !el.querySelector(`*:contains("${searchString}")`)) {
        return el;
      }
    }

    return null;
  }

  /**
   * Generate a CSS selector for an element
   */
  private getSelector(el: Element): string {
    if (el.id) {
      return `#${el.id}`;
    }

    const parts: string[] = [];
    let current: Element | null = el;
    let depth = 0;

    while (current && current !== document.body && depth < 4) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
        return `#${current.id} ${parts.length > 0 ? '> ' + parts.join(' > ') : ''}`.trim();
      }

      // Add meaningful classes
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.split(/\s+/).filter(c => {
          // Filter out random-looking classes
          return c && !/^[a-z]{4,8}$/i.test(c) && !/^css-/.test(c);
        });
        if (classes.length > 0) {
          selector += '.' + classes.slice(0, 2).join('.');
        }
      }

      parts.unshift(selector);
      current = current.parentElement;
      depth++;
    }

    return parts.join(' > ');
  }
}
