/**
 * Console Interceptor Code
 *
 * This code is injected into the MAIN world to intercept console methods.
 * It captures log, warn, error, info, and debug calls and posts them to
 * the content script via window.postMessage.
 */

export const CONSOLE_INTERCEPTOR_CODE = `
(function() {
  // Skip if already initialized
  if (window.__browserCodeConsoleLogs) return;

  const MAX_LOGS = 1000;
  const logs = [];
  window.__browserCodeConsoleLogs = logs;

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  function formatArg(arg) {
    if (arg === undefined) return 'undefined';
    if (arg === null) return 'null';
    if (typeof arg === 'function') return '[Function]';
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }

  function capture(level, args) {
    const entry = {
      level,
      timestamp: Date.now(),
      message: Array.from(args).map(formatArg).join(' '),
    };
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();

    // Notify content script
    window.postMessage({ type: '__BROWSER_CODE_CONSOLE__', entry }, '*');
  }

  console.log = function(...args) { capture('log', args); return originalConsole.log(...args); };
  console.warn = function(...args) { capture('warn', args); return originalConsole.warn(...args); };
  console.error = function(...args) { capture('error', args); return originalConsole.error(...args); };
  console.info = function(...args) { capture('info', args); return originalConsole.info(...args); };
  console.debug = function(...args) { capture('debug', args); return originalConsole.debug(...args); };
})();
`;

/**
 * Get the console interceptor as a function that can be executed
 */
export function getConsoleInterceptorFunction(): () => void {
  return () => {
    // Skip if already initialized
    if ((window as unknown as { __browserCodeConsoleLogs?: unknown[] }).__browserCodeConsoleLogs) return;

    const MAX_LOGS = 1000;
    const logs: Array<{ level: string; timestamp: number; message: string }> = [];
    (window as unknown as { __browserCodeConsoleLogs: unknown[] }).__browserCodeConsoleLogs = logs;

    const originalConsole = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
    };

    function formatArg(arg: unknown): string {
      if (arg === undefined) return 'undefined';
      if (arg === null) return 'null';
      if (typeof arg === 'function') return '[Function]';
      if (arg instanceof Error) return arg.stack || arg.message || String(arg);
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }

    function capture(level: string, args: unknown[]) {
      const entry = {
        level,
        timestamp: Date.now(),
        message: Array.from(args).map(formatArg).join(' '),
      };
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs.shift();

      // Notify content script
      window.postMessage({ type: '__BROWSER_CODE_CONSOLE__', entry }, '*');
    }

    console.log = function(...args: unknown[]) { capture('log', args); return originalConsole.log(...args); };
    console.warn = function(...args: unknown[]) { capture('warn', args); return originalConsole.warn(...args); };
    console.error = function(...args: unknown[]) { capture('error', args); return originalConsole.error(...args); };
    console.info = function(...args: unknown[]) { capture('info', args); return originalConsole.info(...args); };
    console.debug = function(...args: unknown[]) { capture('debug', args); return originalConsole.debug(...args); };
  };
}
