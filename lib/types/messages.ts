import type { ToolResult, ImageMediaType } from './tools';

// Agent mode types
export type AgentMode = 'plan' | 'execute';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// Messages from sidebar to background
export interface ChatMessage {
  type: 'CHAT_MESSAGE';
  content: string;
  tabId: number;
}

export interface GetSettingsMessage {
  type: 'GET_SETTINGS';
}

export interface SaveSettingsMessage {
  type: 'SAVE_SETTINGS';
  settings: Partial<Settings>;
}

export interface GetEditsForUrlMessage {
  type: 'GET_EDITS_FOR_URL';
  url: string;
}

export interface SaveScriptMessage {
  type: 'SAVE_SCRIPT';
  name: string;
  urlPattern: URLPattern;
  operations: EditOperation[];
}

export interface GetAllScriptsMessage {
  type: 'GET_ALL_SCRIPTS';
}

export interface DeleteScriptMessage {
  type: 'DELETE_SCRIPT';
  id: string;
}

export interface ApplyScriptMessage {
  type: 'APPLY_SCRIPT';
  id: string;
  tabId: number;
}

export interface ClearHistoryMessage {
  type: 'CLEAR_HISTORY';
  tabId: number;
}

export interface StopAgentMessage {
  type: 'STOP_AGENT';
  tabId: number;
}

export interface GetHistoryMessage {
  type: 'GET_HISTORY';
  tabId: number;
}

export interface GetVfsFilesMessage {
  type: 'GET_VFS_FILES';
  tabId: number;
}

export interface DeleteVfsFileMessage {
  type: 'DELETE_VFS_FILE';
  tabId: number;
  fileType: 'script' | 'style';
  fileName: string;
}

export interface ExportAllScriptsMessage {
  type: 'EXPORT_ALL_SCRIPTS';
}

export interface GetAllVfsFilesMessage {
  type: 'GET_ALL_VFS_FILES';
}

export interface CopyVfsFileMessage {
  type: 'COPY_VFS_FILE';
  sourceDomain: string;
  sourceUrlPath: string;
  fileType: 'script' | 'style';
  fileName: string;
  targetTabId: number;
  /** Optional custom target path. If not provided, uses the tab's current pathname. */
  targetPath?: string;
}

export interface DeleteVfsFileAnyMessage {
  type: 'DELETE_VFS_FILE_ANY';
  domain: string;
  urlPath: string;
  fileType: 'script' | 'style';
  fileName: string;
}

export interface ImportAllScriptsMessage {
  type: 'IMPORT_ALL_SCRIPTS';
  data: VfsExportData;
  tabId: number;
}

// Export data format
export interface VfsExportData {
  version: 1;
  exportedAt: number;
  domains: Record<string, DomainExportData>;
}

export interface DomainExportData {
  paths: Record<string, PathExportData>;
}

export interface PathExportData {
  scripts: Record<string, { content: string; version: number; created: number; modified: number }>;
  styles: Record<string, { content: string; version: number; created: number; modified: number }>;
  editRecords?: Array<{ selector: string; oldContent: string; newContent: string; timestamp: number }>;
}

// Messages from background to content script
export interface ExecuteToolMessage {
  type: 'EXECUTE_TOOL';
  tool: string;
  input: unknown;
  toolCallId: string;
}

export interface ApplyEditsMessage {
  type: 'APPLY_EDITS';
  edits: SavedEdit[];
}

// Messages from background to sidebar
export interface AgentResponseMessage {
  type: 'AGENT_RESPONSE';
  content: AssistantContent[];
}

export interface ToolCallMessage {
  type: 'TOOL_CALL';
  toolName: string;
  input: unknown;
  toolCallId: string;
}

export interface ToolResultMessage {
  type: 'TOOL_RESULT';
  toolCallId: string;
  result: ToolResult;
}

export interface AgentDoneMessage {
  type: 'AGENT_DONE';
}

export interface AgentErrorMessage {
  type: 'AGENT_ERROR';
  error: string;
}

// Plan mode messages (background to sidebar)
export interface ModeChangedMessage {
  type: 'MODE_CHANGED';
  mode: AgentMode;
}

export interface TodosUpdatedMessage {
  type: 'TODOS_UPDATED';
  todos: TodoItem[];
}

// Message from content script to background to execute script in main world
export interface ExecuteInMainWorldMessage {
  type: 'EXECUTE_IN_MAIN_WORLD';
  code: string;
}

// Message from content script to background to capture screenshot
export interface CaptureScreenshotMessage {
  type: 'CAPTURE_SCREENSHOT';
  format?: 'png' | 'jpeg';
  quality?: number;
}

// Message to check if userScripts API is available
export interface HasUserScriptsMessage {
  type: 'HAS_USER_SCRIPTS';
}

export interface SyncLocalToVfsMessage {
  type: 'SYNC_LOCAL_TO_VFS';
  data: {
    domain: string;
    urlPath: string;
    fileType: 'scripts' | 'styles';
    fileName: string;
    content: string;
  };
}

export interface CleanupVfsPathsMessage {
  type: 'CLEANUP_VFS_PATHS';
}

// Plan mode messages (sidebar to background)
export interface SetModeMessage {
  type: 'SET_MODE';
  tabId: number;
  mode: AgentMode;
}

export interface GetModeMessage {
  type: 'GET_MODE';
  tabId: number;
}

export interface ApprovePlanMessage {
  type: 'APPROVE_PLAN';
  tabId: number;
}

export interface RejectPlanMessage {
  type: 'REJECT_PLAN';
  tabId: number;
  feedback?: string;
}

// Union types
export type SidebarToBackgroundMessage =
  | ChatMessage
  | GetSettingsMessage
  | SaveSettingsMessage
  | GetEditsForUrlMessage
  | SaveScriptMessage
  | GetAllScriptsMessage
  | DeleteScriptMessage
  | ApplyScriptMessage
  | ClearHistoryMessage
  | GetHistoryMessage
  | GetVfsFilesMessage
  | DeleteVfsFileMessage
  | StopAgentMessage
  | ExportAllScriptsMessage
  | ImportAllScriptsMessage
  | GetAllVfsFilesMessage
  | CopyVfsFileMessage
  | DeleteVfsFileAnyMessage
  | ExecuteInMainWorldMessage
  | CaptureScreenshotMessage
  | HasUserScriptsMessage
  | SyncLocalToVfsMessage
  | CleanupVfsPathsMessage
  | SetModeMessage
  | GetModeMessage
  | ApprovePlanMessage
  | RejectPlanMessage;

export interface GetVfsFilesContentMessage {
  type: 'GET_VFS_FILES';
}

export interface DeleteVfsFileContentMessage {
  type: 'DELETE_VFS_FILE';
  fileType: 'script' | 'style';
  fileName: string;
}

export interface InvalidateVfsCacheContentMessage {
  type: 'INVALIDATE_VFS_CACHE';
}

export interface VfsReadContentMessage {
  type: 'VFS_READ';
  path: string;
}

export type BackgroundToContentMessage =
  | ExecuteToolMessage
  | ApplyEditsMessage
  | GetVfsFilesContentMessage
  | DeleteVfsFileContentMessage
  | InvalidateVfsCacheContentMessage
  | VfsReadContentMessage;

export type BackgroundToSidebarMessage =
  | AgentResponseMessage
  | ToolCallMessage
  | ToolResultMessage
  | AgentDoneMessage
  | AgentErrorMessage
  | ModeChangedMessage
  | TodosUpdatedMessage;

// Settings
export interface Settings {
  apiKey: string;
  model: string;
  enabled: boolean;
}

// Saved edits
export interface URLPattern {
  type: 'exact' | 'pattern' | 'domain' | 'regex';
  value: string;
}

export interface EditOperation {
  tool: string;
  path: string;
  action: string;
  oldValue?: string;
  newValue?: string;
}

export interface SavedEdit {
  id: string;
  urlPattern: URLPattern;
  operations: EditOperation[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  metadata: {
    name?: string;
    source: 'manual' | 'ai';
  };
}

// Claude API types
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | (TextContent | ImageContent)[];
}

export type AssistantContent = TextContent | ToolUseContent;
export type UserContent = TextContent | ToolResultContent;

export interface Message {
  role: 'user' | 'assistant';
  content: string | (TextContent | ToolUseContent | ToolResultContent)[];
}
