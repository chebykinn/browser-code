import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './tools';
import { PLAN_MODE_TOOLS, EXECUTE_MODE_TOOLS, PLAN_MODE_SYSTEM_PROMPT } from './plan-tools';
import type { Message, AssistantContent, ToolResultContent, AgentMode, TodoItem, TextContent, ImageContent } from '@/lib/types/messages';
import type { ReadResult } from '@/lib/types/tools';

const MAX_TURNS = 500;

export interface AgentCallbacks {
  onAssistantMessage: (content: AssistantContent[]) => void;
  onToolCall: (toolName: string, input: unknown, toolCallId: string) => void;
  onToolResult: (toolCallId: string, result: unknown) => void;
  onDone: () => void;
  onError: (error: string) => void;
  onTodosUpdated?: (todos: TodoItem[]) => void;
}

export interface AgentOptions {
  apiKey: string;
  model?: string;
  tabId: number;
  history: Message[];
  callbacks: AgentCallbacks;
  abortSignal?: AbortSignal;
  mode?: AgentMode;
  todos?: TodoItem[];
}

/**
 * Run the Claude agent loop
 * Sends user message, executes tool calls, repeats until done
 */
export async function runAgent(
  userMessage: string,
  options: AgentOptions
): Promise<void> {
  const {
    apiKey,
    model = 'claude-opus-4-5-20251101',
    tabId,
    history,
    callbacks,
    abortSignal,
    mode = 'plan',
    todos = [],
  } = options;

  // Select tools and system prompt based on mode
  const tools = mode === 'plan' ? PLAN_MODE_TOOLS : EXECUTE_MODE_TOOLS;
  const systemPrompt = mode === 'plan' ? PLAN_MODE_SYSTEM_PROMPT : SYSTEM_PROMPT;

  // Track todos locally (will be updated by TodoWrite tool)
  let currentTodos = [...todos];

  console.log('[Page Editor] Starting agent with model:', model);
  console.log('[Page Editor] Mode:', mode);
  console.log('[Page Editor] User message:', userMessage);
  console.log('[Page Editor] Tab ID:', tabId);
  console.log('[Page Editor] History length:', history.length);

  const anthropic = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true, // Required for extension context
  });

  // Add new user message to history
  history.push({ role: 'user', content: userMessage });

  // Use history as messages (history is mutated to preserve across calls)
  const messages = history;

  let turns = 0;

  while (turns < MAX_TURNS) {
    // Check if aborted before starting new turn
    if (abortSignal?.aborted) {
      console.log('[Page Editor] Agent aborted by user');
      callbacks.onError('Stopped by user');
      return;
    }

    turns++;
    console.log('[Page Editor] Agent turn:', turns);

    try {
      console.log('[Page Editor] Calling Claude API...');
      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: 16384,
          system: systemPrompt,
          tools: tools,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        },
        { signal: abortSignal }
      );

      console.log('[Page Editor] Claude API response received');
      console.log('[Page Editor] Stop reason:', response.stop_reason);
      console.log('[Page Editor] Content blocks:', response.content.length);

      // Extract content blocks
      const assistantContent = response.content as AssistantContent[];

      // Add assistant message to history
      messages.push({ role: 'assistant', content: assistantContent });

      // Notify about assistant message
      callbacks.onAssistantMessage(assistantContent);

      // Check for tool calls
      const toolCalls = assistantContent.filter(
        (block): block is { type: 'tool_use'; id: string; name: string; input: unknown } =>
          block.type === 'tool_use'
      );

      console.log('[Page Editor] Tool calls found:', toolCalls.length);

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        console.log('[Page Editor] No tool calls, agent done');
        callbacks.onDone();
        return;
      }

      // Execute tool calls
      const toolResults: ToolResultContent[] = [];

      for (const call of toolCalls) {
        // Check if aborted before each tool
        if (abortSignal?.aborted) {
          console.log('[Page Editor] Agent aborted during tool execution');
          callbacks.onError('Stopped by user');
          return;
        }

        console.log('[Page Editor] Executing tool:', call.name, call.input);
        callbacks.onToolCall(call.name, call.input, call.id);

        try {
          let toolResult: unknown;

          // Handle TodoRead and TodoWrite in the background
          if (call.name === 'TodoRead') {
            toolResult = { todos: currentTodos };
            console.log('[Page Editor] TodoRead result:', toolResult);
          } else if (call.name === 'TodoWrite') {
            const input = call.input as { todos: TodoItem[] };
            currentTodos = input.todos || [];
            toolResult = { success: true, count: currentTodos.length };
            console.log('[Page Editor] TodoWrite updated todos:', currentTodos.length);
            // Notify about todos update
            callbacks.onTodosUpdated?.(currentTodos);
          } else {
            // Send tool execution request to content script
            console.log('[Page Editor] Sending to content script, tabId:', tabId);
            const response = await sendToContentScript(tabId, {
              type: 'EXECUTE_TOOL',
              tool: call.name,
              input: call.input,
              toolCallId: call.id,
            });
            toolResult = response.result;
          }

          console.log('[Page Editor] Tool response:', toolResult);
          callbacks.onToolResult(call.id, toolResult);

          // Check if this is a Read result with image data
          const readResult = toolResult as ReadResult;
          if (readResult.image) {
            console.log('[Page Editor] Image result detected, formatting as image content block');
            // Format as image content block for Claude
            const textPart: TextContent = {
              type: 'text',
              text: JSON.stringify({ success: true, path: readResult.path, version: readResult.version }),
            };
            const imagePart: ImageContent = {
              type: 'image',
              source: {
                type: 'base64',
                media_type: readResult.image.mediaType,
                data: readResult.image.data,
              },
            };
            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: [textPart, imagePart],
            });
          } else {
            // Regular text result - truncate if too large
            const resultStr = JSON.stringify(toolResult, null, 2);
            const MAX_RESULT_LENGTH = 15000;
            let truncatedResult = resultStr;
            if (resultStr.length > MAX_RESULT_LENGTH) {
              truncatedResult = resultStr.slice(0, MAX_RESULT_LENGTH) +
                `\n\n[TRUNCATED - Result was ${resultStr.length} chars. Use more specific queries or offset/limit params.]`;
              console.log('[Page Editor] Tool result truncated from', resultStr.length, 'to', MAX_RESULT_LENGTH);
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: truncatedResult,
            });
          }
        } catch (error) {
          console.error('[Page Editor] Tool execution error:', error);
          const errorStr =
            error instanceof Error ? error.message : 'Unknown error executing tool';

          callbacks.onToolResult(call.id, { error: errorStr });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify({ error: errorStr }),
          });
        }
      }

      // Add tool results to messages
      messages.push({ role: 'user', content: toolResults });

      // Check stop reason
      if (response.stop_reason === 'end_turn') {
        console.log('[Page Editor] End turn, agent done');
        callbacks.onDone();
        return;
      }
    } catch (error) {
      // Check if this was an abort
      if (abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        console.log('[Page Editor] Agent aborted');
        callbacks.onError('Stopped by user');
        return;
      }
      console.error('[Page Editor] Agent error:', error);
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      callbacks.onError(errorMessage);
      return;
    }
  }

  callbacks.onError(`Agent reached maximum turns (${MAX_TURNS})`);
}

/**
 * Send message to content script, injecting it first if needed
 */
async function sendToContentScript(
  tabId: number,
  message: unknown
): Promise<{ result: unknown }> {
  try {
    // Try to send message directly first
    return await browser.tabs.sendMessage(tabId, message);
  } catch (error) {
    // If content script not loaded, try to inject it
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      errorMsg.includes('Could not establish connection') ||
      errorMsg.includes('Receiving end does not exist')
    ) {
      console.log('[Page Editor] Content script not found, injecting...');

      try {
        // Inject the content script (works for both MV2 and MV3)
        if (browser.scripting) {
          // MV3 (Chrome)
          await browser.scripting.executeScript({
            target: { tabId },
            files: ['content-scripts/content.js'],
          });
        } else {
          // MV2 (Firefox)
          await browser.tabs.executeScript(tabId, {
            file: '/content-scripts/content.js',
          });
        }

        // Wait a bit for the content script to initialize
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Try again
        return await browser.tabs.sendMessage(tabId, message);
      } catch (injectError) {
        console.error('[Page Editor] Failed to inject content script:', injectError);
        throw new Error(
          `Cannot access this page. The page may be a special browser page (about:, chrome:, etc.) that doesn't allow extensions.`
        );
      }
    }
    throw error;
  }
}
