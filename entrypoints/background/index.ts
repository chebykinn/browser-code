import { runAgent } from './claude/client';
import { getSettings, saveSettings, getEditsForUrl, saveEdit, deleteEdit, getAllEdits } from './storage';
import { initKeepAliveListener, startKeepAlive, stopKeepAlive } from './keep-alive';
import type {
  SidebarToBackgroundMessage,
  BackgroundToSidebarMessage,
  AssistantContent,
  SavedEdit,
  VfsExportData,
  DomainExportData,
  AgentMode,
  TodoItem,
} from '@/lib/types/messages';

import type { Message } from '@/lib/types/messages';
import { getConsoleInterceptorFunction } from '../content/console/interceptor';

// ============================================================================
// Route Matching Utilities (for dynamic routes like [slug] and [...slug])
// ============================================================================

interface RoutePatternInfo {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  isCatchAll: boolean;
}

function escapeRegexChars(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a URL path by removing trailing slashes (except for root "/")
 */
function normalizeUrlPath(path: string): string {
  if (path === '/' || path === '') return '/';
  return path.replace(/\/+$/, '');
}

function parseRoutePatternForBackground(pattern: string): RoutePatternInfo {
  const segments = pattern.split('/').filter(Boolean);
  const paramNames: string[] = [];
  let isCatchAll = false;
  const regexParts: string[] = ['^'];

  for (const segment of segments) {
    const catchAllMatch = segment.match(/^\[\.\.\.(\w+)\]$/);
    if (catchAllMatch) {
      paramNames.push(catchAllMatch[1]);
      isCatchAll = true;
      regexParts.push('/(.+)');
      continue;
    }

    const dynamicMatch = segment.match(/^\[(\w+)\]$/);
    if (dynamicMatch) {
      paramNames.push(dynamicMatch[1]);
      regexParts.push('/([^/]+)');
      continue;
    }

    regexParts.push('/' + escapeRegexChars(segment));
  }

  if (segments.length === 0) {
    regexParts.push('/');
  }

  if (!isCatchAll) {
    regexParts.push('/?$');
  } else {
    regexParts.push('$');
  }

  return {
    pattern,
    regex: new RegExp(regexParts.join('')),
    paramNames,
    isCatchAll,
  };
}

function isDynamicPattern(path: string): boolean {
  return /\[[\w.]+\]/.test(path);
}

function vfsPatternToMatchPattern(domain: string, vfsPath: string): string {
  const matchPath = vfsPath
    .replace(/\[\.\.\.[\w]+\]/g, '*')
    .replace(/\[[\w]+\]/g, '*');
  return `*://${domain}${matchPath}*`;
}

function wrapScriptWithParamExtraction(script: string, pattern: string): string {
  const routePattern = parseRoutePatternForBackground(pattern);

  if (routePattern.paramNames.length === 0) {
    return script;
  }

  return `
(function() {
  var paramNames = ${JSON.stringify(routePattern.paramNames)};
  var regex = ${routePattern.regex.toString()};
  var isCatchAll = ${routePattern.isCatchAll};

  var urlPath = window.location.pathname;
  var match = urlPath.match(regex);

  if (!match) {
    console.log('[VFS] Route pattern mismatch, skipping script for pattern:', ${JSON.stringify(pattern)});
    return;
  }

  var params = {};
  for (var i = 0; i < paramNames.length; i++) {
    var value = match[i + 1];
    if (isCatchAll && i === paramNames.length - 1) {
      params[paramNames[i]] = value.split('/');
    } else {
      params[paramNames[i]] = value;
    }
  }

  window.__routeParams = window.__routeParams || {};
  Object.assign(window.__routeParams, params);
  console.log('[VFS] Route params:', params);

  ${script}
})();
`;
}

// ============================================================================

// Store active sidebar connections by tabId - supports reconnection after tab switch
type Port = ReturnType<typeof browser.runtime.connect>;
const sidebarPorts = new Map<number, Port>();

// Store conversation history per tab (tabId -> messages)
const conversationHistory = new Map<number, Message[]>();

// Store active agent AbortControllers per tabId
const activeAgents = new Map<number, AbortController>();

// Store agent mode per tab (default: 'plan')
const tabModes = new Map<number, AgentMode>();

// Store todos per tab
const tabTodos = new Map<number, TodoItem[]>();

// Track if agent is awaiting plan approval per tab
const awaitingPlanApproval = new Map<number, boolean>();

// Reference counter for keep-alive management
let activeAgentCount = 0;

async function incrementActiveAgents(): Promise<void> {
  activeAgentCount++;
  if (activeAgentCount === 1) {
    await startKeepAlive();
  }
}

async function decrementActiveAgents(): Promise<void> {
  activeAgentCount = Math.max(0, activeAgentCount - 1);
  if (activeAgentCount === 0) {
    await stopKeepAlive();
  }
}

export default defineBackground(() => {
  console.log('[Page Editor] Background script loaded');

  // Initialize keep-alive alarm listener
  initKeepAliveListener();

  // Initialize userScripts API for running user scripts (Chrome MV3)
  initUserScripts();

  // Inject console interceptor when tabs load
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      injectConsoleInterceptor(tabId);
    }
  });

  // Handle connections from sidebar
  browser.runtime.onConnect.addListener((port) => {
    // Port name format: "sidebar:tab:{tabId}"
    if (!port.name.startsWith('sidebar:tab:')) return;

    const tabIdStr = port.name.replace('sidebar:tab:', '');
    const tabId = parseInt(tabIdStr, 10);
    if (isNaN(tabId)) {
      console.error('[Page Editor] Invalid tabId in port name:', port.name);
      return;
    }
    console.log('[Page Editor] Sidebar connected for tabId:', tabId);

    // Replace old port if reconnecting (this is the key fix for tab switching)
    sidebarPorts.set(tabId, port);

    port.onDisconnect.addListener(() => {
      console.log('[Page Editor] Port disconnected for tabId:', tabId);
      // Only delete if this is still the current port (prevents race conditions)
      if (sidebarPorts.get(tabId) === port) {
        sidebarPorts.delete(tabId);
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
      console.log('[Page Editor] CHAT_MESSAGE received, tabId:', tabId);

      // Cancel any existing agent for this tab
      const existingController = activeAgents.get(tabId);
      if (existingController) {
        console.log('[Page Editor] Aborting previous agent for tabId:', tabId);
        existingController.abort();
      }

      // Create new AbortController for this agent run
      const abortController = new AbortController();
      activeAgents.set(tabId, abortController);

      // Get or create conversation history for this tab
      if (!conversationHistory.has(tabId)) {
        conversationHistory.set(tabId, []);
      }
      const history = conversationHistory.get(tabId)!;

      // Get mode and todos for this tab
      const mode = tabModes.get(tabId) || 'plan';
      const todos = tabTodos.get(tabId) || [];

      // Start keep-alive before running agent
      await incrementActiveAgents();

      // Run the agent with existing history
      // CRITICAL: Use LIVE port lookup in callbacks so reconnecting sidebar receives messages
      await runAgent(message.content, {
        apiKey: settings.apiKey,
        model: settings.model,
        tabId,
        history,
        abortSignal: abortController.signal,
        mode,
        todos,
        callbacks: {
          onAssistantMessage: (content: AssistantContent[]) => {
            // Live lookup: get current port for this tab (may have reconnected)
            const currentPort = sidebarPorts.get(tabId);
            sendToSidebar(currentPort, {
              type: 'AGENT_RESPONSE',
              content,
            });
          },
          onToolCall: (toolName, input, toolCallId) => {
            const currentPort = sidebarPorts.get(tabId);
            sendToSidebar(currentPort, {
              type: 'TOOL_CALL',
              toolName,
              input,
              toolCallId,
            });
          },
          onToolResult: (toolCallId, result) => {
            const currentPort = sidebarPorts.get(tabId);
            sendToSidebar(currentPort, {
              type: 'TOOL_RESULT',
              toolCallId,
              result: result as never,
            });
          },
          onTodosUpdated: (updatedTodos: TodoItem[]) => {
            tabTodos.set(tabId, updatedTodos);
            const currentPort = sidebarPorts.get(tabId);
            sendToSidebar(currentPort, {
              type: 'TODOS_UPDATED',
              todos: updatedTodos,
            });
          },
          onDone: async () => {
            activeAgents.delete(tabId);
            await decrementActiveAgents();
            const currentPort = sidebarPorts.get(tabId);
            // In plan mode, mark as awaiting approval
            if (mode === 'plan') {
              awaitingPlanApproval.set(tabId, true);
            }
            sendToSidebar(currentPort, { type: 'AGENT_DONE' });
          },
          onError: async (error) => {
            activeAgents.delete(tabId);
            await decrementActiveAgents();
            const currentPort = sidebarPorts.get(tabId);
            sendToSidebar(currentPort, { type: 'AGENT_ERROR', error });
          },
        },
      });

      return { success: true };
    }

    case 'STOP_AGENT': {
      const tabId = message.tabId;
      const controller = activeAgents.get(tabId);
      if (controller) {
        console.log('[Page Editor] Stopping agent for tabId:', tabId);
        controller.abort();
        activeAgents.delete(tabId);
        await decrementActiveAgents();
      }
      return { success: true };
    }

    case 'CLEAR_HISTORY': {
      const tabId = message.tabId;
      conversationHistory.delete(tabId);
      // Reset to plan mode and clear todos
      tabModes.set(tabId, 'plan');
      tabTodos.delete(tabId);
      awaitingPlanApproval.delete(tabId);
      console.log('[Page Editor] Cleared history for tabId:', tabId);
      // Notify sidebar of mode reset
      const currentPort = sidebarPorts.get(tabId);
      sendToSidebar(currentPort, { type: 'MODE_CHANGED', mode: 'plan' });
      return { success: true };
    }

    case 'GET_HISTORY': {
      const tabId = message.tabId;
      const history = conversationHistory.get(tabId) || [];
      console.log('[Page Editor] GET_HISTORY for tabId:', tabId, 'length:', history.length);
      return { history };
    }

    case 'SET_MODE': {
      const tabId = message.tabId;
      const newMode = message.mode;
      tabModes.set(tabId, newMode);
      console.log('[Page Editor] SET_MODE for tabId:', tabId, 'mode:', newMode);
      const currentPort = sidebarPorts.get(tabId);
      sendToSidebar(currentPort, { type: 'MODE_CHANGED', mode: newMode });
      return { success: true, mode: newMode };
    }

    case 'GET_MODE': {
      const tabId = message.tabId;
      const mode = tabModes.get(tabId) || 'plan';
      const todos = tabTodos.get(tabId) || [];
      const awaiting = awaitingPlanApproval.get(tabId) || false;
      console.log('[Page Editor] GET_MODE for tabId:', tabId, 'mode:', mode);
      return { mode, todos, awaitingApproval: awaiting };
    }

    case 'APPROVE_PLAN': {
      const tabId = message.tabId;
      console.log('[Page Editor] APPROVE_PLAN for tabId:', tabId);

      // Clear awaiting state
      awaitingPlanApproval.delete(tabId);

      // Switch to execute mode
      tabModes.set(tabId, 'execute');

      // Notify sidebar of mode change
      const currentPort = sidebarPorts.get(tabId);
      sendToSidebar(currentPort, { type: 'MODE_CHANGED', mode: 'execute' });

      // Create fresh history for execution and store it in the map
      // so mutations during execution are tracked
      const execHistory: Message[] = [];
      conversationHistory.set(tabId, execHistory);

      // Fetch the plan.md content from the content script
      let planContent = '';
      try {
        const planResponse = await browser.tabs.sendMessage(tabId, {
          type: 'VFS_READ',
          path: './plan.md',
        }) as { content?: string; code?: string };
        if (planResponse.content) {
          planContent = planResponse.content;
        }
      } catch (err) {
        console.log('[Page Editor] Could not read plan.md:', err);
      }

      // Get the plan content to use as context for execution
      // Include both the plan and todos
      const todos = tabTodos.get(tabId) || [];
      let planContext = 'Execute the approved plan.\n\n';
      if (planContent) {
        planContext += `## Plan\n${planContent}\n\n`;
      }
      if (todos.length > 0) {
        planContext += `## Tasks\n${todos.map(t => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`).join('\n')}\n\n`;
      }
      planContext += 'Proceed with the first pending task.';

      // Start execution
      const settings = await getSettings();
      if (settings.apiKey) {
        const abortController = new AbortController();
        activeAgents.set(tabId, abortController);

        // Start keep-alive before running agent
        await incrementActiveAgents();

        runAgent(planContext, {
          apiKey: settings.apiKey,
          model: settings.model,
          tabId,
          history: execHistory,
          abortSignal: abortController.signal,
          mode: 'execute',
          todos,
          callbacks: {
            onAssistantMessage: (content: AssistantContent[]) => {
              const port = sidebarPorts.get(tabId);
              sendToSidebar(port, { type: 'AGENT_RESPONSE', content });
            },
            onToolCall: (toolName, input, toolCallId) => {
              const port = sidebarPorts.get(tabId);
              sendToSidebar(port, { type: 'TOOL_CALL', toolName, input, toolCallId });
            },
            onToolResult: (toolCallId, result) => {
              const port = sidebarPorts.get(tabId);
              sendToSidebar(port, { type: 'TOOL_RESULT', toolCallId, result: result as never });
            },
            onTodosUpdated: (updatedTodos: TodoItem[]) => {
              tabTodos.set(tabId, updatedTodos);
              const port = sidebarPorts.get(tabId);
              sendToSidebar(port, { type: 'TODOS_UPDATED', todos: updatedTodos });
            },
            onDone: async () => {
              activeAgents.delete(tabId);
              await decrementActiveAgents();
              const port = sidebarPorts.get(tabId);
              sendToSidebar(port, { type: 'AGENT_DONE' });
            },
            onError: async (error) => {
              activeAgents.delete(tabId);
              await decrementActiveAgents();
              const port = sidebarPorts.get(tabId);
              sendToSidebar(port, { type: 'AGENT_ERROR', error });
            },
          },
        });
      }

      return { success: true };
    }

    case 'REJECT_PLAN': {
      const tabId = message.tabId;
      const feedback = message.feedback;
      console.log('[Page Editor] REJECT_PLAN for tabId:', tabId, 'feedback:', feedback);

      // Clear awaiting state but stay in plan mode
      awaitingPlanApproval.delete(tabId);

      // If feedback provided, send it as a new message to revise the plan
      if (feedback) {
        const settings = await getSettings();
        if (settings.apiKey) {
          const history = conversationHistory.get(tabId) || [];
          const abortController = new AbortController();
          activeAgents.set(tabId, abortController);

          const todos = tabTodos.get(tabId) || [];

          // Start keep-alive before running agent
          await incrementActiveAgents();

          runAgent(`Please revise the plan based on this feedback: ${feedback}`, {
            apiKey: settings.apiKey,
            model: settings.model,
            tabId,
            history,
            abortSignal: abortController.signal,
            mode: 'plan',
            todos,
            callbacks: {
              onAssistantMessage: (content: AssistantContent[]) => {
                const port = sidebarPorts.get(tabId);
                sendToSidebar(port, { type: 'AGENT_RESPONSE', content });
              },
              onToolCall: (toolName, input, toolCallId) => {
                const port = sidebarPorts.get(tabId);
                sendToSidebar(port, { type: 'TOOL_CALL', toolName, input, toolCallId });
              },
              onToolResult: (toolCallId, result) => {
                const port = sidebarPorts.get(tabId);
                sendToSidebar(port, { type: 'TOOL_RESULT', toolCallId, result: result as never });
              },
              onTodosUpdated: (updatedTodos: TodoItem[]) => {
                tabTodos.set(tabId, updatedTodos);
                const port = sidebarPorts.get(tabId);
                sendToSidebar(port, { type: 'TODOS_UPDATED', todos: updatedTodos });
              },
              onDone: async () => {
                activeAgents.delete(tabId);
                await decrementActiveAgents();
                awaitingPlanApproval.set(tabId, true);
                const port = sidebarPorts.get(tabId);
                sendToSidebar(port, { type: 'AGENT_DONE' });
              },
              onError: async (error) => {
                activeAgents.delete(tabId);
                await decrementActiveAgents();
                const port = sidebarPorts.get(tabId);
                sendToSidebar(port, { type: 'AGENT_ERROR', error });
              },
            },
          });
        }
      }

      return { success: true };
    }

    case 'GET_VFS_FILES': {
      const tabId = message.tabId;
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Content script timeout - page may need refresh')), 5000)
        );
        const response = await Promise.race([
          sendToContentScript(tabId, { type: 'GET_VFS_FILES' }),
          timeoutPromise
        ]);
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
          for (const [rawUrlPath, pathData] of Object.entries(domainData.paths)) {
            // Normalize path to avoid duplicates with/without trailing slash
            const urlPath = normalizeUrlPath(rawUrlPath);

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
        type FileInfo = { name: string; version: number; modified: number; enabled: boolean };
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
                  enabled: (file as { enabled?: boolean }).enabled !== false,  // undefined = enabled
                }));
                const styles: FileInfo[] = Object.entries(pathData.styles || {}).map(([name, file]) => ({
                  name,
                  version: (file as { version: number }).version,
                  modified: (file as { modified: number }).modified,
                  enabled: (file as { enabled?: boolean }).enabled !== false,  // undefined = enabled
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

    case 'CLEANUP_VFS_PATHS': {
      // Merge duplicate paths (e.g., '/path' and '/path/' -> '/path')
      try {
        const allStorage = await browser.storage.local.get(null);
        let totalMerged = 0;

        for (const [key, value] of Object.entries(allStorage)) {
          if (!key.startsWith('vfs:')) continue;

          const domainData = value as DomainExportData;
          if (!domainData?.paths) continue;

          const normalizedPaths: Record<string, typeof domainData.paths[string]> = {};
          let hasDuplicates = false;

          for (const [rawPath, pathData] of Object.entries(domainData.paths)) {
            const normalizedPath = normalizeUrlPath(rawPath);

            if (normalizedPaths[normalizedPath]) {
              // Merge into existing
              hasDuplicates = true;
              const existing = normalizedPaths[normalizedPath];

              // Merge scripts (newer version wins)
              for (const [name, file] of Object.entries(pathData.scripts || {})) {
                const existingFile = existing.scripts[name];
                if (!existingFile || (file as any).version > existingFile.version) {
                  existing.scripts[name] = file;
                }
              }

              // Merge styles
              for (const [name, file] of Object.entries(pathData.styles || {})) {
                const existingFile = existing.styles[name];
                if (!existingFile || (file as any).version > existingFile.version) {
                  existing.styles[name] = file;
                }
              }

              totalMerged++;
            } else {
              normalizedPaths[normalizedPath] = {
                scripts: { ...pathData.scripts },
                styles: { ...pathData.styles },
                editRecords: pathData.editRecords || [],
              };
            }
          }

          if (hasDuplicates) {
            domainData.paths = normalizedPaths;
            await browser.storage.local.set({ [key]: domainData });
          }
        }

        return { success: true, merged: totalMerged };
      } catch (error) {
        console.error('[Page Editor] CLEANUP_VFS_PATHS error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'COPY_VFS_FILE': {
      try {
        const { sourceDomain, sourceUrlPath, fileType, fileName, targetTabId, targetPath } = message;
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

        // Get target tab's URL to determine target domain
        const tab = await browser.tabs.get(targetTabId);
        if (!tab.url) {
          return { success: false, error: 'Cannot determine target URL' };
        }

        const targetUrl = new URL(tab.url);
        const targetDomain = targetUrl.hostname;
        // Use custom targetPath if provided, otherwise use tab's pathname
        const targetUrlPath = targetPath || targetUrl.pathname;
        const targetStorageKey = `vfs:${targetDomain}`;

        console.log('[Page Editor] Copying file to path:', targetUrlPath, targetPath ? '(custom)' : '(from tab)');

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

    case 'TOGGLE_VFS_FILE_ENABLED': {
      try {
        const { domain, urlPath, fileType, fileName, enabled } = message as {
          domain: string;
          urlPath: string;
          fileType: 'script' | 'style';
          fileName: string;
          enabled: boolean;
        };
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

        collection[fileName].enabled = enabled;
        await browser.storage.local.set({ [storageKey]: domainData });

        console.log('[Page Editor] Toggled', fileName, 'enabled:', enabled);
        return { success: true };
      } catch (error) {
        console.error('[Page Editor] TOGGLE_VFS_FILE_ENABLED error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'SET_ALL_VFS_FILES_ENABLED': {
      try {
        const { domain, urlPath, fileType, enabled } = message as {
          domain: string;
          urlPath: string;
          fileType: 'script' | 'style';
          enabled: boolean;
        };
        const storageKey = `vfs:${domain}`;

        const result = await browser.storage.local.get(storageKey);
        const domainData = result[storageKey] as DomainExportData;

        if (!domainData?.paths?.[urlPath]) {
          return { success: false, error: 'Path not found', count: 0 };
        }

        const collection = fileType === 'script'
          ? domainData.paths[urlPath].scripts
          : domainData.paths[urlPath].styles;

        let count = 0;
        for (const name of Object.keys(collection || {})) {
          collection[name].enabled = enabled;
          count++;
        }

        if (count > 0) {
          await browser.storage.local.set({ [storageKey]: domainData });
        }

        console.log('[Page Editor] Set all', fileType, 'files enabled:', enabled, 'count:', count);
        return { success: true, count };
      } catch (error) {
        console.error('[Page Editor] SET_ALL_VFS_FILES_ENABLED error:', error);
        return { success: false, error: String(error), count: 0 };
      }
    }

    case 'HAS_USER_SCRIPTS': {
      // Check if userScripts API is available
      const available = getUserScriptsAPI() !== undefined;
      return { available };
    }

    case 'SYNC_LOCAL_TO_VFS': {
      try {
        const { domain, urlPath, fileType, fileName, content } = message.data;
        const storageKey = `vfs:${domain}`;

        const result = await browser.storage.local.get(storageKey);
        const domainData = (result[storageKey] as DomainExportData) || { paths: {} };

        // Ensure path exists
        if (!domainData.paths[urlPath]) {
          domainData.paths[urlPath] = { scripts: {}, styles: {} };
        }

        const collection = fileType === 'scripts'
          ? domainData.paths[urlPath].scripts
          : domainData.paths[urlPath].styles;

        // Get existing version or start at 1
        const existingFile = collection?.[fileName] as { version?: number } | undefined;
        const version = (existingFile?.version || 0) + 1;

        // Update file
        collection[fileName] = {
          content,
          version,
          created: existingFile ? (existingFile as { created?: number }).created || Date.now() : Date.now(),
          modified: Date.now(),
        };

        await browser.storage.local.set({ [storageKey]: domainData });

        console.log('[Page Editor] Synced local file to VFS:', fileName, 'at', domain, urlPath);
        return { success: true, version };
      } catch (error) {
        console.error('[Page Editor] SYNC_LOCAL_TO_VFS error:', error);
        return { success: false, error: String(error) };
      }
    }

    case 'CAPTURE_SCREENSHOT': {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) {
          return { success: false, error: 'No tab ID available' };
        }

        const format = (message as { format?: 'png' | 'jpeg' }).format || 'png';
        const quality = (message as { quality?: number }).quality;

        const options: { format: 'png' | 'jpeg'; quality?: number } = { format };
        if (format === 'jpeg' && quality !== undefined) {
          options.quality = quality;
        }

        // @ts-expect-error - webextension-polyfill types are too strict, undefined works for current window
        const dataUrl = await browser.tabs.captureVisibleTab(undefined, options);

        return {
          success: true,
          dataUrl,
          format,
        };
      } catch (error) {
        console.error('[Page Editor] CAPTURE_SCREENSHOT error:', error);
        return { success: false, error: String(error) };
      }
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

/**
 * Inject console interceptor into the page's MAIN world.
 * This captures console.log/warn/error/info/debug calls.
 */
async function injectConsoleInterceptor(tabId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: getConsoleInterceptorFunction(),
      injectImmediately: true,
    });
  } catch (error) {
    // Silently fail - this is expected for special pages like about:, chrome:, etc.
    // console.log('[Page Editor] Console interceptor injection skipped:', tabId);
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
        const vfsChanges = Object.entries(changes)
          .filter(([key]) => key.startsWith('vfs:'))
          .map(([key, change]) => ({ key, ...change }));

        if (vfsChanges.length > 0) {
          console.log('[Page Editor] VFS storage changed, syncing userScripts');
          syncUserScripts();

          // Relay VFS changes to all connected sidepanels (Firefox fix)
          // Firefox MV3 doesn't broadcast storage.onChanged cross-context
          for (const [tabId, port] of sidebarPorts) {
            try {
              port.postMessage({
                type: 'VFS_STORAGE_CHANGED',
                changes: vfsChanges,
              });
            } catch (e) {
              // Port may be disconnected
            }
          }
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
          // Skip disabled scripts (enabled !== false means enabled, undefined = enabled)
          if (scriptFile.enabled === false) {
            console.log('[Page Editor] Skipping disabled script:', scriptName);
            continue;
          }

          const scriptId = `vfs_${domain}_${urlPath}_${scriptName}`.replace(/[^a-zA-Z0-9_]/g, '_');

          // Create match pattern for this domain/path (supports dynamic routes)
          const matchPattern = vfsPatternToMatchPattern(domain, urlPath);

          // Wrap script with param extraction if it's a dynamic route
          const wrappedScript = isDynamicPattern(urlPath)
            ? wrapScriptWithParamExtraction(scriptFile.content, urlPath)
            : scriptFile.content;

          console.log('[Page Editor] Found script:', scriptName, 'for pattern:', matchPattern,
            isDynamicPattern(urlPath) ? '(dynamic route)' : '(exact match)');

          scriptsToRegister.push({
            id: scriptId,
            matches: [matchPattern],
            js: [{ code: wrappedScript }],
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
