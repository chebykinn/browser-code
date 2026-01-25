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

  // Check if this is a Write to plan.md
  const input = toolCall.input as Record<string, unknown> | null;
  const writePath = input?.path ?? input?.file_path;
  const isPlanWrite =
    toolCall.name === 'Write' &&
    typeof writePath === 'string' &&
    writePath.endsWith('plan.md');

  const planContent = isPlanWrite && input?.content
    ? String(input.content)
    : null;

  // Show plan inline if it's a plan write with content
  if (isPlanWrite && planContent && hasResult && !isError) {
    return (
      <div className="plan-display">
        <div className="plan-header">Plan</div>
        <div className="plan-content">
          <SimpleMarkdown content={planContent} />
        </div>
      </div>
    );
  }

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

/**
 * Simple markdown renderer for plan display
 */
function SimpleMarkdown({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactElement[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let codeLanguage = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block start/end
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={i} className="md-code-block" data-lang={codeLanguage}>
            <code>{codeLines.join('\n')}</code>
          </pre>
        );
        codeLines = [];
        codeLanguage = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLanguage = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headers
    if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="md-h1">{line.slice(2)}</h1>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="md-h2">{line.slice(3)}</h2>);
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="md-h3">{line.slice(4)}</h3>);
    }
    // Checkbox list items
    else if (line.match(/^- \[[ x]\] /)) {
      const checked = line[3] === 'x';
      const text = line.slice(6);
      elements.push(
        <div key={i} className="md-checkbox">
          <input type="checkbox" checked={checked} readOnly />
          <span>{text}</span>
        </div>
      );
    }
    // Regular list items
    else if (line.startsWith('- ')) {
      elements.push(<li key={i} className="md-li">{line.slice(2)}</li>);
    }
    // Empty lines
    else if (line.trim() === '') {
      elements.push(<div key={i} className="md-spacer" />);
    }
    // Regular text
    else {
      elements.push(<p key={i} className="md-p">{line}</p>);
    }
  }

  return <div className="simple-markdown">{elements}</div>;
}
