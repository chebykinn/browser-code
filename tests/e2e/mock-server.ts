/**
 * Mock Anthropic API server for E2E tests.
 *
 * Exposes:
 *   POST /v1/messages    — returns next queued response
 *   POST /test/setup     — configure response queue for the next test
 *   OPTIONS /v1/messages — CORS preflight
 *   GET  /test-page      — minimal HTML page for extension to act on
 *
 * Usage:
 *   const server = await startMockServer();
 *   // In test: configure responses before interacting with the extension
 *   await fetch(`http://localhost:${server.port}/test/setup`, {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ responses: [bashToolUseResponse('echo hi'), endTurnResponse('Done!')] }),
 *   });
 *   server.close();
 */

import { createServer, type Server } from 'node:http';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, anthropic-version, anthropic-beta',
};

let responseQueue: object[] = [];

/** Anthropic-format response that triggers a Bash tool approval */
export function bashToolUseResponse(command: string): object {
  return {
    id: 'msg_test_bash',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-5-20251101',
    content: [
      { type: 'text', text: "I'll run a command to help." },
      {
        type: 'tool_use',
        id: 'toolu_test_bash',
        name: 'Bash',
        input: { command },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

/** Anthropic-format response that triggers a Write tool approval */
export function writeToolUseResponse(filePath: string, content: string): object {
  return {
    id: 'msg_test_write',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-5-20251101',
    content: [
      { type: 'text', text: "I'll write the file." },
      {
        type: 'tool_use',
        id: 'toolu_test_write',
        name: 'Write',
        input: { path: filePath, content },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

/** Anthropic-format final response that ends the conversation */
export function endTurnResponse(text: string): object {
  return {
    id: 'msg_test_done',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-5-20251101',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 30 },
  };
}

export interface MockServer {
  port: number;
  close: () => void;
}

export function startMockServer(port = 4242): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      // Always add CORS headers
      Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Parse body for POST requests
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const url = req.url ?? '';

          if (url === '/v1/messages') {
            const response = responseQueue.shift();
            if (!response) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'No response queued in mock server' } }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            return;
          }

          if (url === '/test/setup') {
            try {
              const { responses } = JSON.parse(body) as { responses: object[] };
              responseQueue = responses ?? [];
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, queued: responseQueue.length }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            }
            return;
          }

          res.writeHead(404);
          res.end();
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/test-page') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Test Page</h1></body></html>');
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}
