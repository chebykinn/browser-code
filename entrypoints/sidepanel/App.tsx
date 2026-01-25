import { useState, useEffect, useRef } from 'react';
import { ChatMessage } from './components/ChatMessage';
import { SettingsPanel } from './components/SettingsPanel';
import { ScriptsPanel } from './components/ScriptsPanel';
import type {
  BackgroundToSidebarMessage,
  AssistantContent,
  Settings,
  AgentMode,
  TodoItem,
} from '@/lib/types/messages';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string | AssistantContent[];
  toolCalls?: Array<{
    name: string;
    input: unknown;
    id: string;
    result?: unknown;
  }>;
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showScripts, setShowScripts] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<AgentMode>('plan');
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  type Port = ReturnType<typeof browser.runtime.connect>;
  const portRef = useRef<Port | null>(null);


  // Refs to always get latest state setters (fixes React Strict Mode issues)
  const setMessagesRef = useRef(setMessages);
  const setIsLoadingRef = useRef(setIsLoading);
  const setModeRef = useRef(setMode);
  const setTodosRef = useRef(setTodos);
  const setAwaitingApprovalRef = useRef(setAwaitingApproval);
  setMessagesRef.current = setMessages;
  setIsLoadingRef.current = setIsLoading;
  setModeRef.current = setMode;
  setTodosRef.current = setTodos;
  setAwaitingApprovalRef.current = setAwaitingApproval;

  // Load settings and get current tab
  useEffect(() => {
    async function init() {
      // Get settings
      const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
      setSettings(response);

      // Get current tab
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        setTabId(tab.id);
      }

      // Check if API key is configured
      if (!response.apiKey) {
        setShowSettings(true);
      }

      // Get mode and todos for this tab
      if (tab?.id) {
        const modeResponse = await browser.runtime.sendMessage({
          type: 'GET_MODE',
          tabId: tab.id,
        });
        setMode(modeResponse.mode || 'plan');
        setTodos(modeResponse.todos || []);
        setAwaitingApproval(modeResponse.awaitingApproval || false);
      }

      // Restore conversation history from backend (if we have a tab)
      if (tab?.id) {
        const historyResponse = await browser.runtime.sendMessage({
          type: 'GET_HISTORY',
          tabId: tab.id,
        });
        if (historyResponse.history && historyResponse.history.length > 0) {
          // Convert backend history to UI messages
          const uiMessages: Message[] = [];
          for (const msg of historyResponse.history) {
            if (msg.role === 'user') {
              // Skip tool_result messages (they have array content with tool_result type)
              if (Array.isArray(msg.content) && msg.content[0]?.type === 'tool_result') {
                continue;
              }
              uiMessages.push({
                id: crypto.randomUUID(),
                role: 'user',
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
              });
            } else if (msg.role === 'assistant') {
              const content = msg.content as AssistantContent[];
              const toolCalls = content
                .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
                .map((tc) => ({ name: tc.name, input: tc.input, id: tc.id }));
              uiMessages.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content,
                toolCalls,
              });
            }
          }
          setMessages(uiMessages);
          console.log(`[Sidebar tab:${tab.id}] Restored ${uiMessages.length} messages from history`);
        }
      }
    }

    init();

    // Listen for tab changes and switch to new tab
    const handleTabActivated = (activeInfo: { tabId: number }) => {
      setTabId((currentTabId) => {
        if (currentTabId && activeInfo.tabId !== currentTabId) {
          console.log('[Page Editor] Tab changed from', currentTabId, 'to', activeInfo.tabId);
        }
        return activeInfo.tabId; // Switch to new tab
      });
    };

    browser.tabs.onActivated.addListener(handleTabActivated);
    return () => {
      browser.tabs.onActivated.removeListener(handleTabActivated);
    };
  }, []);

  // Set up port connection to background - keyed by tabId for reconnection support
  useEffect(() => {
    // Wait for tabId before connecting
    if (!tabId) return;

    console.log(`[Sidebar tab:${tabId}] Setting up port connection...`);
    // Use tabId in port name so background can route messages after reconnection
    const port = browser.runtime.connect({ name: `sidebar:tab:${tabId}` });
    portRef.current = port;

    const messageHandler = (message: BackgroundToSidebarMessage) => {
      console.log(`[Sidebar tab:${tabId}] Received message:`, message.type);

      switch (message.type) {
        case 'AGENT_RESPONSE': {
          console.log(`[Sidebar tab:${tabId}] AGENT_RESPONSE`);
          const content = message.content;
          setTimeout(() => {
            setMessagesRef.current((prev) => {
              console.log(`[Sidebar tab:${tabId}] setMessages prev:`, prev.length);
              const lastMessage = prev[prev.length - 1];
              if (lastMessage?.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  { ...lastMessage, content },
                ];
              } else {
                return [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: 'assistant' as const,
                    content,
                    toolCalls: [],
                  },
                ];
              }
            });
          }, 0);
          break;
        }

        case 'TOOL_CALL': {
          console.log('[Page Editor Sidebar] TOOL_CALL:', message.toolName);
          const toolName = message.toolName;
          const toolInput = message.input;
          const toolId = message.toolCallId;
          setTimeout(() => {
            setMessagesRef.current((prev) => {
              const lastMessage = prev[prev.length - 1];
              if (lastMessage?.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...lastMessage,
                    toolCalls: [
                      ...(lastMessage.toolCalls || []),
                      { name: toolName, input: toolInput, id: toolId },
                    ],
                  },
                ];
              }
              return prev;
            });
          }, 0);

          break;
        }

        case 'TOOL_RESULT': {
          const resultToolId = message.toolCallId;
          const resultData = message.result;
          setTimeout(() => {
            setMessagesRef.current((prev) => {
              const lastMessage = prev[prev.length - 1];
              if (lastMessage?.role === 'assistant' && lastMessage.toolCalls) {
                const updatedToolCalls = lastMessage.toolCalls.map((tc) =>
                  tc.id === resultToolId ? { ...tc, result: resultData } : tc
                );
                return [
                  ...prev.slice(0, -1),
                  { ...lastMessage, toolCalls: updatedToolCalls },
                ];
              }
              return prev;
            });
          }, 0);
          break;
        }

        case 'AGENT_DONE': {
          setTimeout(() => {
            setIsLoadingRef.current(false);
            // Check if we're awaiting approval after plan mode completes
            browser.runtime.sendMessage({ type: 'GET_MODE', tabId }).then((response) => {
              setAwaitingApprovalRef.current(response.awaitingApproval || false);
            });
          }, 0);
          break;
        }

        case 'MODE_CHANGED': {
          setTimeout(() => {
            setModeRef.current(message.mode);
            // Clear awaiting approval when mode changes
            setAwaitingApprovalRef.current(false);
          }, 0);
          break;
        }

        case 'TODOS_UPDATED': {
          setTimeout(() => setTodosRef.current(message.todos), 0);
          break;
        }

        case 'AGENT_ERROR': {
          const errorMsg = message.error;
          setTimeout(() => {
            setIsLoadingRef.current(false);
            setMessagesRef.current((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `Error: ${errorMsg}`,
              },
            ]);
          }, 0);
          break;
        }
      }
    };

    port.onMessage.addListener(messageHandler);

    port.onDisconnect.addListener(() => {
      console.log(`[Sidebar tab:${tabId}] Port disconnected`);
    });

    console.log(`[Sidebar tab:${tabId}] Port connected`);

    return () => {
      port.disconnect();
    };
  }, [tabId]);

  // Re-fetch history and URL when tab changes
  useEffect(() => {
    if (!tabId) return;
    const currentTabId = tabId; // Capture for use in async function

    // Reset loading state when switching tabs
    setIsLoading(false);

    async function fetchTabData() {
      // Get tab URL
      try {
        const tab = await browser.tabs.get(currentTabId);
        setPageUrl(tab.url || null);
      } catch {
        setPageUrl(null);
      }

      // Get mode and todos
      const modeResponse = await browser.runtime.sendMessage({
        type: 'GET_MODE',
        tabId: currentTabId,
      });
      setMode(modeResponse.mode || 'plan');
      setTodos(modeResponse.todos || []);
      setAwaitingApproval(modeResponse.awaitingApproval || false);

      // Get history
      console.log(`[Sidebar tab:${currentTabId}] Fetching history for tab change`);
      const historyResponse = await browser.runtime.sendMessage({
        type: 'GET_HISTORY',
        tabId: currentTabId,
      });
      if (historyResponse.history && historyResponse.history.length > 0) {
        // Convert backend history to UI messages
        const uiMessages: Message[] = [];
        for (const msg of historyResponse.history) {
          if (msg.role === 'user') {
            // Skip tool_result messages (they have array content with tool_result type)
            if (Array.isArray(msg.content) && msg.content[0]?.type === 'tool_result') {
              continue;
            }
            uiMessages.push({
              id: crypto.randomUUID(),
              role: 'user',
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            });
          } else if (msg.role === 'assistant') {
            const content = msg.content as AssistantContent[];
            const toolCalls = content
              .filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } => b.type === 'tool_use')
              .map((tc) => ({ name: tc.name, input: tc.input, id: tc.id }));
            uiMessages.push({
              id: crypto.randomUUID(),
              role: 'assistant',
              content,
              toolCalls,
            });
          }
        }
        setMessages(uiMessages);
        console.log(`[Sidebar tab:${currentTabId}] Restored ${uiMessages.length} messages from history`);
      } else {
        setMessages([]); // Clear messages if new tab has no history
        console.log(`[Sidebar tab:${currentTabId}] No history found, cleared messages`);
      }
    }

    fetchTabData();
  }, [tabId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !tabId) return;

    const userMessage = input.trim();
    setInput('');

    // If currently loading, this is a follow-up message - stop current agent first
    if (isLoading) {
      await browser.runtime.sendMessage({
        type: 'STOP_AGENT',
        tabId,
      });
    }

    setIsLoading(true);

    // Add user message
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: userMessage },
    ]);

    // Send to background
    try {
      await browser.runtime.sendMessage({
        type: 'CHAT_MESSAGE',
        content: userMessage,
        tabId,
      });
    } catch (error) {
      setIsLoading(false);
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ]);
    }
  };

  const handleSaveSettings = async (newSettings: Partial<Settings>) => {
    const response = await browser.runtime.sendMessage({
      type: 'SAVE_SETTINGS',
      settings: newSettings,
    });
    setSettings(response);
    setShowSettings(false);
  };

  const handleNewChat = async () => {
    setMessages([]);
    setInput('');
    // Clear conversation history on backend
    if (tabId) {
      await browser.runtime.sendMessage({
        type: 'CLEAR_HISTORY',
        tabId,
      });
    }
  };

  const handleStop = async () => {
    try {
      await browser.runtime.sendMessage({
        type: 'STOP_AGENT',
        tabId,
      });
      setIsLoading(false);
    } catch (error) {
      console.error('[Page Editor] Error stopping agent:', error);
    }
  };

  const handleApprovePlan = async () => {
    if (!tabId) return;
    setAwaitingApproval(false);
    setIsLoading(true);
    setMessages([]); // Clear messages for fresh execution
    try {
      await browser.runtime.sendMessage({
        type: 'APPROVE_PLAN',
        tabId,
      });
    } catch (error) {
      console.error('[Page Editor] Error approving plan:', error);
      setIsLoading(false);
    }
  };

  const handleRejectPlan = () => {
    // Just dismiss the approval UI - user can type feedback in the chat
    setAwaitingApproval(false);
  };

  const handleToggleMode = async () => {
    if (!tabId || isLoading) return;
    const newMode = mode === 'plan' ? 'execute' : 'plan';
    try {
      await browser.runtime.sendMessage({
        type: 'SET_MODE',
        tabId,
        mode: newMode,
      });
      setMode(newMode);
    } catch (error) {
      console.error('[Page Editor] Error toggling mode:', error);
    }
  };

  if (showSettings) {
    return (
      <SettingsPanel
        settings={settings}
        onSave={handleSaveSettings}
        onClose={() => setShowSettings(false)}
      />
    );
  }

  if (showScripts) {
    return (
      <ScriptsPanel
        tabId={tabId}
        onClose={() => setShowScripts(false)}
      />
    );
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Browser Code</h1>
        <div className="header-buttons">
          <button
            className={`mode-indicator ${mode}`}
            onClick={handleToggleMode}
            disabled={isLoading}
            title={mode === 'plan' ? 'Plan Mode: Agent creates a plan first' : 'Execute Mode: Agent executes directly'}
          >
            {mode === 'plan' ? 'Plan' : 'Exec'}
          </button>
          <button
            className="header-button"
            onClick={handleNewChat}
            disabled={isLoading}
            title="Start new chat"
          >
            New
          </button>
          <button
            className="header-button"
            onClick={() => setShowScripts(true)}
            title="Browse saved files"
          >
            Files
          </button>
          <button
            className="header-button"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {pageUrl && (
        <div className="page-url" title={pageUrl}>
          {pageUrl}
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Ask me to modify this page.</p>
            <p className="hint">
              Try: "Hide all ads" or "Change the header color to blue"
            </p>
          </div>
        )}

        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}

        {isLoading && (
          <div className="loading">
            <span className="loading-dot">●</span>
            <span className="loading-dot">●</span>
            <span className="loading-dot">●</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {awaitingApproval && !isLoading && (
        <div className="plan-approval">
          <div className="plan-approval-buttons">
            <button className="approve-button" onClick={handleApprovePlan}>
              Approve & Execute
            </button>
            <button className="reject-button" onClick={handleRejectPlan}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <form className="input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={awaitingApproval ? "Type feedback to revise plan..." : isLoading ? "Type follow-up message..." : "Ask me to modify this page..."}
          disabled={!tabId}
        />
        {isLoading ? (
          <button type="button" onClick={handleStop} className="stop-button">
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || !tabId}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
