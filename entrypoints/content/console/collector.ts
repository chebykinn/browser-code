/**
 * Console Collector
 *
 * Listens for console log messages from the MAIN world interceptor
 * and stores them for retrieval via the VFS.
 */

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  timestamp: number;
  message: string;
}

class ConsoleCollector {
  private logs: ConsoleEntry[] = [];
  private maxLogs = 1000;
  private initialized = false;

  /**
   * Initialize the collector to listen for console messages
   */
  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    window.addEventListener('message', (event) => {
      // Only accept messages from the same window
      if (event.source !== window) return;
      if (event.data?.type === '__BROWSER_CODE_CONSOLE__') {
        this.addLog(event.data.entry as ConsoleEntry);
      }
    });

    console.log('[Console Collector] Initialized');
  }

  /**
   * Add a log entry
   */
  addLog(entry: ConsoleEntry): void {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  /**
   * Get all captured logs
   */
  getLogs(): ConsoleEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs as formatted text (for VFS read)
   */
  getLogsAsText(): string {
    if (this.logs.length === 0) {
      return '// No console logs captured yet\n';
    }

    return this.logs
      .map((entry) => {
        const time = new Date(entry.timestamp).toISOString();
        const level = entry.level.toUpperCase().padEnd(5);
        return `[${time}] [${level}] ${entry.message}`;
      })
      .join('\n');
  }

  /**
   * Get log count
   */
  getCount(): number {
    return this.logs.length;
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.logs = [];
  }
}

// Singleton instance
let collectorInstance: ConsoleCollector | null = null;

/**
 * Get the console collector singleton
 */
export function getConsoleCollector(): ConsoleCollector {
  if (!collectorInstance) {
    collectorInstance = new ConsoleCollector();
  }
  return collectorInstance;
}
