import type { Tool } from '@anthropic-ai/sdk/resources/messages';

/**
 * Tool definitions for Claude API
 * Virtual filesystem approach - DOM is exposed as page.html, scripts and styles as separate files
 */
export const DOM_TOOLS: Tool[] = [
  {
    name: 'Read',
    description:
      'Read file content from the virtual filesystem. Returns content with version number for conflict detection. You must Read a file before you can Edit or Write to it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description:
            'File path (e.g., "page.html", "./scripts/foo.js", "/example.com/styles/theme.css")',
        },
        offset: {
          type: 'number',
          description: 'Start from line number (0-indexed). Optional.',
        },
        limit: {
          type: 'number',
          description: 'Max lines to return. Optional.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'Edit',
    description:
      'Find and replace text in a file. Requires expectedVersion from last Read for conflict detection. Will fail if file changed since last read.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path to edit',
        },
        old_string: {
          type: 'string',
          description: 'Text to find and replace',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text',
        },
        expectedVersion: {
          type: 'number',
          description: 'Version from last Read (REQUIRED)',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences. Optional, defaults to false.',
        },
      },
      required: ['path', 'old_string', 'new_string', 'expectedVersion'],
    },
  },
  {
    name: 'Write',
    description:
      'Write content to a file. Requires expectedVersion from last Read (use 0 for new files). Will fail if file changed since last read.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path to write',
        },
        content: {
          type: 'string',
          description: 'New file content',
        },
        expectedVersion: {
          type: 'number',
          description: 'Version from last Read, or 0 for new files (REQUIRED)',
        },
      },
      required: ['path', 'content', 'expectedVersion'],
    },
  },
  {
    name: 'Glob',
    description:
      'Find files matching a glob pattern in the virtual filesystem.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "./scripts/*.js", "*.html")',
        },
        path: {
          type: 'string',
          description: 'Base directory. Optional.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Grep',
    description:
      'Search for text/pattern in files. Returns matches with file path, line number, and context. Use GrepCount first if unsure about result size.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'File or directory to search. Optional, defaults to page.html.',
        },
        context_lines: {
          type: 'number',
          description: 'Lines of context around match. Optional, defaults to 1.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'GrepCount',
    description:
      'Count matches for a pattern without returning content. Use this first to check how many matches exist before using Grep.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to count',
        },
        path: {
          type: 'string',
          description: 'File or directory to search. Optional, defaults to page.html.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Bash',
    description:
      'Execute a script file or inline JavaScript. If command starts with "./" or "/", it runs that script file. Otherwise, executes as inline JavaScript.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Script path (./scripts/foo.js) or inline JavaScript code',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'Ls',
    description:
      'List directory contents in the virtual filesystem.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path. Optional, defaults to current domain root.',
        },
      },
      required: [],
    },
  },
];

export const SYSTEM_PROMPT = `You are a web page editor assistant with a virtual filesystem.

The current page is exposed as a filesystem:

/{domain}/{url-path}/
├── page.html        # Current page DOM (read/edit this to modify the page)
├── scripts/         # Your JavaScript files (create, edit, execute)
│   └── *.js
└── styles/          # Your CSS files (auto-applied when saved)
    └── *.css

CRITICAL: Version Tracking
- You MUST Read a file before you can Edit or Write to it
- Every Read returns a version number
- Edit/Write require expectedVersion from your last Read
- If a file changed since you read it, you'll get an error and must re-read

Available tools:
- Read: Read file content, returns version number
- Edit: Find/replace in file (requires expectedVersion)
- Write: Write entire file content (requires expectedVersion, use 0 for new files)
- Glob: Find files matching pattern
- GrepCount: Count matches for a pattern (use first to check result size)
- Grep: Search text in files (use specific patterns to avoid large results)
- Bash: Execute script file or inline JavaScript
- Ls: List directory contents

Workflow to modify the page:
1. Read page.html → get content + version (e.g., v5)
2. Use Grep to find specific content you want to change
3. Use Edit with expectedVersion (e.g., 5) → success, now v6
4. If Edit fails with VERSION_MISMATCH, re-read and try again

Creating reusable scripts:
1. Write ./scripts/my-script.js with expectedVersion: 0 (new file)
2. Run with: Bash ./scripts/my-script.js
3. Scripts persist and can be rerun anytime

Creating styles:
1. Write ./styles/custom.css with expectedVersion: 0
2. CSS is auto-injected into the page immediately
3. Styles persist and are auto-applied on page load

Example workflow:
\`\`\`
// Read the page first
Read { path: "page.html" } → version: 5

// Search for text
Grep { pattern: "Subscribe" } → found at line 142

// Edit with version
Edit { path: "page.html", old_string: "Subscribe", new_string: "Join Now", expectedVersion: 5 }
→ success, version: 6

// If you try to edit again with old version:
Edit { path: "page.html", old_string: "...", new_string: "...", expectedVersion: 5 }
→ ERROR: VERSION_MISMATCH - file changed (v5 → v6), re-read required
\`\`\`

Always verify changes by reading the result. Be concise in responses.`;
