import { runAgent } from './claude/client';
import { getSettings, saveSettings, getEditsForUrl, saveEdit, deleteEdit, getAllEdits } from './storage';
import type {
  SidebarToBackgroundMessage,
  BackgroundToSidebarMessage,
  AssistantContent,
  SavedEdit,
  VfsExportData,
  DomainExportData,
} from '@/lib/types/messages';

import type { Message } from '@/lib/types/messages';

// Store active sidebar connections by sidebarId - supports multiple windows
type Port = ReturnType<typeof browser.runtime.connect>;
const sidebarPorts = new Map<string, Port>();

// Store conversation history per tab (tabId -> messages)
const conversationHistory = new Map<number, Message[]>();

// Store active agent AbortControllers per sidebarId
const activeAgents = new Map<string, AbortController>();

export default defineBackground(() => {
  console.log('[Page Editor] Background script loaded');

  // Initialize userScripts API for running user scripts (Chrome MV3)
  initUserScripts();

  // Handle connections from sidebar
  browser.runtime.onConnect.addListener((port) => {
    // Port name format: "sidebar:{sidebarId}"
    if (!port.name.startsWith('sidebar:')) return;

    const sidebarId = port.name.replace('sidebar:', '');
    console.log('[Page Editor] Sidebar connected, sidebarId:', sidebarId.slice(0, 8));

    sidebarPorts.set(sidebarId, port);

    port.onDisconnect.addListener(() => {
      console.log('[Page Editor] Port disconnected, sidebarId:', sidebarId.slice(0, 8));
      if (sidebarPorts.get(sidebarId) === port) {
        sidebarPorts.delete(sidebarId);
      }
    });
  });

  // Handle messages from sidebar and content scripts
  browser.runtime.onMessage.addListener(
    (message: SidebarToBackgroundMessage, sender, sendResponse) => {
      handleMessage(message, sender)
        .then(sendResponse)
        .catch((error) => {
          console.error('[Page Editor] Error handling message:', error);
          sendResponse({ error: error.message });
        });

      return true; // Async response
    }
  );

  // Set up side panel behavior (Chrome)
  if (browser.sidePanel) {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  // Handle extension icon click (cross-browser: action for MV3, browserAction for MV2)
  const actionApi = browser.action || browser.browserAction;
  if (actionApi?.onClicked) {
    actionApi.onClicked.addListener(async (tab) => {
      if (!tab.id) return;

      // Open side panel (Chrome) or popup (Firefox)
      if (browser.sidePanel) {
        await browser.sidePanel.open({ tabId: tab.id });
      }
    });
  }
});

type MessageSender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];

async function handleMessage(
  message: SidebarToBackgroundMessage,
  sender: MessageSender
): Promise<unknown> {
  switch (message.type) {
    case 'CHAT_MESSAGE': {
      const settings = await getSettings();

      if (!settings.apiKey) {
        return { error: 'API key not configured. Please set your Anthropic API key in settings.' };
      }

      const tabId = message.tabId;
      const sidebarId = message.sidebarId;
      console.log('[Page Editor] CHAT_MESSAGE received, tabId:', tabId, 'sidebarId:', sidebarId.slice(0, 8));

      const port = sidebarPorts.get(sidebarId);
      console.log('[Page Editor] Got port for sidebarId', sidebarId.slice(0, 8), ':', !!port);

      // Cancel any existing agent for this sidebar
      const existingController = activeAgents.get(sidebarId);
      if (existingController) {
        console.log('[Page Editor] Aborting previous agent for sidebarId:', sidebarId.slice(0, 8));
        existingController.abort();
      }

      // Create new AbortController for this agent run
      const abortController = new AbortController();
      activeAgents.set(sidebarId, abortController);

      // Get or create conversation history for this tab
      if (!conversationHistory.has(tabId)) {
        conversationHistory.set(tabId, []);
      }
      const history = conversationHistory.get(tabId)!;

      // Run the agent with existing history
      await runAgent(message.content, {
        apiKey: settings.apiKey,
        model: settings.model,
        tabId,
        history,
        abortSignal: abortController.signal,
        callbacks: {
          onAssistantMessage: (content: AssistantContent[]) => {
            sendToSidebar(port, {
              type: 'AGENT_RESPONSE',
              content,
            });
          },
          onToolCall: (toolName, input, toolCallId) => {
            sendToSidebar(port, {
              type: 'TOOL_CALL',
              toolName,
              input,
              toolCallId,
            });
          },
          onToolResult: (toolCallId, result) => {
            sendToSidebar(port, {
              type: 'TOOL_RESULT',
              toolCallId,
              result: result as never,
            });
          },
          onDone: () => {
            activeAgents.delete(sidebarId);
            sendToSidebar(port, { type: 'AGENT_DONE' });
          },
          onError: (error) => {
            activeAgents.delete(sidebarId);
            sendToSidebar(port, { type: 'AGENT_ERROR', error });
          },
        },
      });

      return { success: true };
    }

    case 'STOP_AGENT': {
      const sidebarId = message.sidebarId;
      const controller = activeAgents.get(sidebarId);
      if (controller) {
        console.log('[Page Editor] Stopping agent for sidebarId:', sidebarId.slice(0, 8));
        controller.abort();
        activeAgents.delete(sidebarId);
      }
      return { success: true };
    }

    case 'CLEAR_HISTORY': {
      const tabId = message.tabId;
      conversationHistory.delete(tabId);
      console.log('[Page Editor] Cleared history for tabId:', tabId);
      return { success: true };
    }

    case 'GET_HISTORY': {
      const tabId = message.tabId;
      const history = conversationHistory.get(tabId) || [];
      console.log('[Page Editor] GET_HISTORY for tabId:', tabId, 'length:', history.length);
      return { history };
    }

    case 'GET_VFS_FILES': {
      const tabId = message.tabId;
      try {
        const response = await sendToContentScript(tabId, { type: 'GET_VFS_FILES' });
        return response;
      } catch (error) {
        console.error('[Page Editor] GET_VFS_FILES error:', error);
        return { scripts: [], styles: [], error: String(error) };
      }
    }

    case 'DELETE_VFS_FILE': {
      const tabId = message.tabId;
      try {
        const response = await sendToContentScript(tabId, {
          type: 'DELETE_VFS_FILE',
          fileType: message.fileType,
          fileName: message.fileName,
        });
        return response;
      } catch (error) {
        console.error('[Page Editor] DELETE_VFS_FILE error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'EXPORT_ALL_SCRIPTS': {
      try {
        // Get all storage keys
        const allStorage = await browser.storage.local.get(null);

        // Filter for VFS keys (vfs:{domain})
        const exportData: VfsExportData = {
          version: 1,
          exportedAt: Date.now(),
          domains: {},
        };

        for (const [key, value] of Object.entries(allStorage)) {
          if (key.startsWith('vfs:')) {
            const domain = key.replace('vfs:', '');
            const domainData = value as DomainExportData;
            if (domainData && domainData.paths) {
              exportData.domains[domain] = domainData;
            }
          }
        }

        console.log('[Page Editor] Exported VFS data:', Object.keys(exportData.domains).length, 'domains');
        return { success: true, data: exportData };
      } catch (error) {
        console.error('[Page Editor] EXPORT_ALL_SCRIPTS error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'IMPORT_ALL_SCRIPTS': {
      try {
        const importData = message.data;

        if (importData.version !== 1) {
          return { success: false, error: 'Unsupported export format version' };
        }

        // Import each domain
        let importedDomains = 0;
        let importedFiles = 0;

        for (const [domain, domainData] of Object.entries(importData.domains)) {
          const storageKey = `vfs:${domain}`;

          // Get existing data for this domain
          const existing = await browser.storage.local.get(storageKey);
          const existingData = (existing[storageKey] as DomainExportData) || { paths: {} };

          // Merge paths
          for (const [urlPath, pathData] of Object.entries(domainData.paths)) {
            if (!existingData.paths[urlPath]) {
              existingData.paths[urlPath] = { scripts: {}, styles: {}, editRecords: [] };
            }

            // Merge scripts
            for (const [name, file] of Object.entries(pathData.scripts || {})) {
              existingData.paths[urlPath].scripts[name] = file;
              importedFiles++;
            }

            // Merge styles
            for (const [name, file] of Object.entries(pathData.styles || {})) {
              existingData.paths[urlPath].styles[name] = file;
              importedFiles++;
            }
          }

          await browser.storage.local.set({ [storageKey]: existingData });
          importedDomains++;
        }

        const domainNames = Object.keys(importData.domains);
        console.log('[Page Editor] Imported VFS data:', importedDomains, 'domains,', importedFiles, 'files, domains:', domainNames);

        // Invalidate VFS cache in content script so it reloads from storage
        if (message.tabId) {
          try {
            await sendToContentScript(message.tabId, { type: 'INVALIDATE_VFS_CACHE' });
            console.log('[Page Editor] VFS cache invalidated for tab:', message.tabId);
          } catch (e) {
            console.log('[Page Editor] Could not invalidate cache:', e);
          }
        }

        return { success: true, importedDomains, importedFiles, domainNames };
      } catch (error) {
        console.error('[Page Editor] IMPORT_ALL_SCRIPTS error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'GET_ALL_VFS_FILES': {
      try {
        const allStorage = await browser.storage.local.get(null);
        type FileInfo = { name: string; version: number; modified: number };
        const allFiles: Record<string, { paths: Record<string, { scripts: FileInfo[]; styles: FileInfo[] }> }> = {};

        for (const [key, value] of Object.entries(allStorage)) {
          if (key.startsWith('vfs:')) {
            const domain = key.replace('vfs:', '');
            const domainData = value as DomainExportData;
            if (domainData && domainData.paths) {
              allFiles[domain] = { paths: {} };
              for (const [urlPath, pathData] of Object.entries(domainData.paths)) {
                const scripts: FileInfo[] = Object.entries(pathData.scripts || {}).map(([name, file]) => ({
                  name,
                  version: (file as { version: number }).version,
                  modified: (file as { modified: number }).modified,
                }));
                const styles: FileInfo[] = Object.entries(pathData.styles || {}).map(([name, file]) => ({
                  name,
                  version: (file as { version: number }).version,
                  modified: (file as { modified: number }).modified,
                }));
                if (scripts.length > 0 || styles.length > 0) {
                  allFiles[domain].paths[urlPath] = { scripts, styles };
                }
              }
            }
          }
        }

        return { success: true, files: allFiles };
      } catch (error) {
        console.error('[Page Editor] GET_ALL_VFS_FILES error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'COPY_VFS_FILE': {
      try {
        const { sourceDomain, sourceUrlPath, fileType, fileName, targetTabId } = message;
        const storageKey = `vfs:${sourceDomain}`;

        // Get source file
        const result = await browser.storage.local.get(storageKey);
        const domainData = result[storageKey] as DomainExportData;
        if (!domainData?.paths?.[sourceUrlPath]) {
          return { success: false, error: 'Source path not found' };
        }

        const collection = fileType === 'script'
          ? domainData.paths[sourceUrlPath].scripts
          : domainData.paths[sourceUrlPath].styles;

        const sourceFile = collection?.[fileName];
        if (!sourceFile) {
          return { success: false, error: 'Source file not found' };
        }

        // Get target tab's URL to determine target domain/path
        const tab = await browser.tabs.get(targetTabId);
        if (!tab.url) {
          return { success: false, error: 'Cannot determine target URL' };
        }

        const targetUrl = new URL(tab.url);
        const targetDomain = targetUrl.hostname;
        const targetUrlPath = targetUrl.pathname;
        const targetStorageKey = `vfs:${targetDomain}`;

        // Get or create target storage
        const targetResult = await browser.storage.local.get(targetStorageKey);
        const targetData = (targetResult[targetStorageKey] as DomainExportData) || { paths: {} };

        if (!targetData.paths[targetUrlPath]) {
          targetData.paths[targetUrlPath] = { scripts: {}, styles: {}, editRecords: [] };
        }

        const targetCollection = fileType === 'script'
          ? targetData.paths[targetUrlPath].scripts
          : targetData.paths[targetUrlPath].styles;

        // Copy file with new version
        targetCollection[fileName] = {
          ...sourceFile,
          version: 1,
          created: Date.now(),
          modified: Date.now(),
        };

        await browser.storage.local.set({ [targetStorageKey]: targetData });

        // Invalidate cache in content script
        try {
          await sendToContentScript(targetTabId, { type: 'INVALIDATE_VFS_CACHE' });
        } catch (e) {
          console.log('[Page Editor] Could not invalidate cache:', e);
        }

        console.log('[Page Editor] Copied file:', fileName, 'to', targetDomain, targetUrlPath);
        return { success: true };
      } catch (error) {
        console.error('[Page Editor] COPY_VFS_FILE error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'DELETE_VFS_FILE_ANY': {
      try {
        const { domain, urlPath, fileType, fileName } = message;
        const storageKey = `vfs:${domain}`;

        const result = await browser.storage.local.get(storageKey);
        const domainData = result[storageKey] as DomainExportData;

        if (!domainData?.paths?.[urlPath]) {
          return { success: false, error: 'Path not found' };
        }

        const collection = fileType === 'script'
          ? domainData.paths[urlPath].scripts
          : domainData.paths[urlPath].styles;

        if (!collection?.[fileName]) {
          return { success: false, error: 'File not found' };
        }

        delete collection[fileName];

        // Clean up empty paths
        const hasScripts = Object.keys(domainData.paths[urlPath].scripts || {}).length > 0;
        const hasStyles = Object.keys(domainData.paths[urlPath].styles || {}).length > 0;
        if (!hasScripts && !hasStyles) {
          delete domainData.paths[urlPath];
        }

        // Clean up empty domains
        if (Object.keys(domainData.paths).length === 0) {
          await browser.storage.local.remove(storageKey);
        } else {
          await browser.storage.local.set({ [storageKey]: domainData });
        }

        console.log('[Page Editor] Deleted file:', fileName, 'from', domain, urlPath);
        return { success: true };
      } catch (error) {
        console.error('[Page Editor] DELETE_VFS_FILE_ANY error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'HAS_USER_SCRIPTS': {
      // Check if userScripts API is available
      const available = getUserScriptsAPI() !== undefined;
      return { available };
    }

    case 'EXECUTE_IN_MAIN_WORLD': {
      try {
        const { code } = message;
        const tabId = sender.tab?.id;
        if (!tabId) {
          return { success: false, error: 'No tab ID available' };
        }
        console.log('[Page Editor] Executing script in tab:', tabId);

        // Execute in MAIN world using scripting API
        // Note: This may fail on pages with strict CSP (like LinkedIn)
        // For those pages, save the script and reload - userScripts will run it
        const results = await browser.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (scriptCode: string) => {
            try {
              const fn = new Function(scriptCode);
              return { success: true, result: fn() };
            } catch (e) {
              return { success: false, error: (e as Error).message || String(e) };
            }
          },
          args: [code],
        });

        const result = results[0]?.result as { success: boolean; result?: unknown; error?: string } | undefined;
        if (!result) {
          return { success: false, error: 'No result from script execution' };
        }
        return result;
      } catch (error) {
        console.error('[Page Editor] EXECUTE_IN_MAIN_WORLD error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'GET_SETTINGS': {
      return await getSettings();
    }

    case 'SAVE_SETTINGS': {
      return await saveSettings(message.settings);
    }

    case 'GET_EDITS_FOR_URL': {
      const edits = await getEditsForUrl(message.url);
      return { edits };
    }

    case 'SAVE_SCRIPT': {
      const script: SavedEdit = {
        id: crypto.randomUUID(),
        urlPattern: message.urlPattern,
        operations: message.operations,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          name: message.name,
          source: 'ai',
        },
      };
      await saveEdit(script);
      return { success: true, id: script.id };
    }

    case 'GET_ALL_SCRIPTS': {
      const scripts = await getAllEdits();
      return { scripts };
    }

    case 'DELETE_SCRIPT': {
      await deleteEdit(message.id);
      return { success: true };
    }

    case 'APPLY_SCRIPT': {
      const scripts = await getAllEdits();
      const script = scripts.find((s) => s.id === message.id);
      if (!script) {
        return { error: 'Script not found' };
      }

      // Apply each operation via content script
      for (const op of script.operations) {
        let input: Record<string, unknown>;
        if (op.tool === 'Bash') {
          input = { command: op.newValue };
        } else {
          input = {
            path: op.path,
            old_string: op.oldValue,
            new_string: op.newValue,
            content: op.newValue,
          };
        }

        await sendToContentScript(message.tabId, {
          type: 'EXECUTE_TOOL',
          tool: op.tool,
          input,
          toolCallId: `apply-${op.tool}-${Date.now()}`,
        });
      }

      return { success: true };
    }

    default:
      throw new Error(`Unknown message type: ${(message as { type: string }).type}`);
  }
}


/**
 * Send message to content script, injecting it first if needed
 */
async function sendToContentScript(
  tabId: number,
  message: unknown
): Promise<unknown> {
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      errorMsg.includes('Could not establish connection') ||
      errorMsg.includes('Receiving end does not exist')
    ) {
      console.log('[Page Editor] Content script not found, injecting...');

      try {
        if (browser.scripting) {
          await browser.scripting.executeScript({
            target: { tabId },
            files: ['content-scripts/content.js'],
          });
        } else {
          await browser.tabs.executeScript(tabId, {
            file: '/content-scripts/content.js',
          });
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
        return await browser.tabs.sendMessage(tabId, message);
      } catch (injectError) {
        console.error('[Page Editor] Failed to inject content script:', injectError);
        throw new Error(
          `Cannot access this page. The page may be a special browser page.`
        );
      }
    }
    throw error;
  }
}

function sendToSidebar(
  port: Port | undefined,
  message: BackgroundToSidebarMessage
): void {
  if (port) {
    try {
      console.log('[Page Editor] Sending to sidebar:', message.type);
      port.postMessage(message);
    } catch (e) {
      console.error('[Page Editor] Failed to send to sidebar:', e);
    }
  } else {
    console.warn('[Page Editor] No port to send message:', message.type);
  }
}

// UserScripts API interface (works for both Chrome and Firefox MV3)
interface UserScriptsAPI {
  configureWorld: (config: { csp?: string; messaging?: boolean }) => Promise<void>;
  getScripts: () => Promise<Array<{ id: string }>>;
  register: (scripts: Array<{
    id: string;
    matches: string[];
    js: Array<{ code: string }>;
    runAt: string;
    world: string;
  }>) => Promise<void>;
  unregister: (filter: { ids: string[] }) => Promise<void>;
}

// Declare chrome global for userScripts API (Chrome)
declare const chrome: {
  userScripts?: UserScriptsAPI;
};

/**
 * Get userScripts API (works for both Chrome and Firefox MV3)
 * Chrome uses chrome.userScripts, Firefox MV3 uses browser.userScripts
 */
function getUserScriptsAPI(): UserScriptsAPI | undefined {
  if (typeof chrome !== 'undefined' && chrome.userScripts) {
    return chrome.userScripts;
  }
  // Firefox MV3 uses browser.userScripts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof browser !== 'undefined' && (browser as any).userScripts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (browser as any).userScripts;
  }
  return undefined;
}

/**
 * Initialize the userScripts API for executing user scripts.
 * This allows scripts to run with a permissive CSP that bypasses page restrictions.
 */
async function initUserScripts(): Promise<void> {
  console.log('[Page Editor] initUserScripts called');

  // Firefox MV3: userScripts is an optional permission that must be requested
  // Check if we have the permission, request it if not
  try {
    const hasPermission = await browser.permissions.contains({ permissions: ['userScripts'] });
    if (!hasPermission) {
      console.log('[Page Editor] userScripts permission not granted, requesting...');
      // Note: This will only work if triggered by user action
      // For now, just log that we need the permission
      console.log('[Page Editor] userScripts permission needs to be granted via extension settings');
    }
  } catch (e) {
    // Chrome doesn't need this check - permission is install-time
    console.log('[Page Editor] Permission check skipped (likely Chrome)');
  }

  const userScriptsApi = getUserScriptsAPI();
  if (!userScriptsApi) {
    console.log('[Page Editor] userScripts API not available (Chrome 120+ or Firefox 128+ required, or permission not granted)');
    return;
  }

  console.log('[Page Editor] userScripts API is available');

  try {
    // Configure the USER_SCRIPT world with permissive CSP
    await userScriptsApi.configureWorld({
      csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval'; object-src 'self';",
      messaging: false,
    });
    console.log('[Page Editor] userScripts world configured');

    // Register all saved scripts
    await syncUserScripts();

    // Listen for storage changes to update registrations
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local') {
        const vfsChanged = Object.keys(changes).some(key => key.startsWith('vfs:'));
        if (vfsChanged) {
          console.log('[Page Editor] VFS storage changed, syncing userScripts');
          syncUserScripts();
        }
      }
    });
  } catch (error) {
    console.error('[Page Editor] Failed to initialize userScripts:', error);
  }
}

/**
 * Sync all saved scripts to userScripts registrations
 */
async function syncUserScripts(): Promise<void> {
  console.log('[Page Editor] syncUserScripts called');

  const userScriptsApi = getUserScriptsAPI();
  if (!userScriptsApi) {
    console.log('[Page Editor] syncUserScripts: no userScripts API');
    return;
  }

  try {
    // Get all registered scripts and unregister them
    const existingScripts = await userScriptsApi.getScripts();
    console.log('[Page Editor] Existing userScripts:', existingScripts.length);
    if (existingScripts.length > 0) {
      await userScriptsApi.unregister({ ids: existingScripts.map(s => s.id) });
      console.log('[Page Editor] Unregistered existing scripts');
    }

    // Get all VFS data from storage
    const allStorage = await browser.storage.local.get(null);
    console.log('[Page Editor] Storage keys:', Object.keys(allStorage).filter(k => k.startsWith('vfs:')));

    const scriptsToRegister: Array<{
      id: string;
      matches: string[];
      js: Array<{ code: string }>;
      runAt: 'document_start' | 'document_end' | 'document_idle';
      world: 'MAIN';
    }> = [];

    for (const [key, value] of Object.entries(allStorage)) {
      if (!key.startsWith('vfs:')) continue;

      const domain = key.replace('vfs:', '');
      const domainData = value as DomainExportData;

      if (!domainData?.paths) continue;

      for (const [urlPath, pathData] of Object.entries(domainData.paths)) {
        if (!pathData.scripts) continue;

        for (const [scriptName, scriptFile] of Object.entries(pathData.scripts)) {
          const scriptId = `vfs_${domain}_${urlPath}_${scriptName}`.replace(/[^a-zA-Z0-9_]/g, '_');

          // Create match pattern for this domain/path
          const matchPattern = `*://${domain}${urlPath}*`;

          console.log('[Page Editor] Found script:', scriptName, 'for pattern:', matchPattern);

          scriptsToRegister.push({
            id: scriptId,
            matches: [matchPattern],
            js: [{ code: scriptFile.content }],
            runAt: 'document_idle',
            world: 'MAIN',
          });
        }
      }
    }

    if (scriptsToRegister.length > 0) {
      console.log('[Page Editor] Registering scripts:', scriptsToRegister.map(s => ({ id: s.id, matches: s.matches })));
      await userScriptsApi.register(scriptsToRegister);
      console.log('[Page Editor] Registered', scriptsToRegister.length, 'userScripts successfully');
    } else {
      console.log('[Page Editor] No scripts to register');
    }
  } catch (error) {
    console.error('[Page Editor] Failed to sync userScripts:', error);
  }
}
