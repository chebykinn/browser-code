import { useState } from 'react';
import type { AssistantContent } from '@/lib/types/messages';

interface ToolCall {
  name: string;
  input: unknown;
  id: string;
  result?: unknown;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string | AssistantContent[];
  toolCalls?: ToolCall[];
}

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-header">
        <span className="message-role">{isUser ? 'You' : 'Claude'}</span>
      </div>

      <div className="message-content">
        {typeof message.content === 'string' ? (
          <p>{message.content}</p>
        ) : (
          <AssistantContentDisplay content={message.content} />
        )}

        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="tool-calls">
            {message.toolCalls.map((tc) => (
              <ToolCallDisplay key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantContentDisplay({ content }: { content: AssistantContent[] }) {
  return (
    <>
      {content.map((block, idx) => {
        if (block.type === 'text') {
          return <p key={idx}>{block.text}</p>;
        }
        // Tool use blocks are handled separately
        return null;
      })}
    </>
  );
}

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const hasResult = toolCall.result !== undefined;
  const isError =
    hasResult &&
    typeof toolCall.result === 'object' &&
    toolCall.result !== null &&
    'error' in toolCall.result;

  return (
    <div className={`tool-call ${hasResult ? (isError ? 'error' : 'success') : 'pending'}`}>
      <button
        className="tool-call-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="tool-icon">
          {!hasResult ? '⏳' : isError ? '❌' : '✓'}
        </span>
        <span className="tool-name">{toolCall.name}</span>
        <span className="expand-icon">{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className="tool-call-details">
          <div className="tool-section">
            <div className="tool-section-header">Input:</div>
            <pre className="tool-code">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {hasResult && (
            <div className="tool-section">
              <div className="tool-section-header">Result:</div>
              <pre className="tool-code">
                {JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
