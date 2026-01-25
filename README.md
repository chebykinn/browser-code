# Browser Code

**A coding agent for userscripts with its own loader.**

Browser Code is a browser extension that gives Claude a virtual filesystem view of web pages. It generates, edits, and manages userscripts that persist to `chrome.userScripts` (the same API that Tampermonkey uses) and auto-run on matching URLs.

Think Claude Code, but for the DOM.

## How It Works

1. **Agent sees the page as a filesystem** - The DOM becomes `page.html`, console output is `console.log`, and you can create scripts in `./scripts/` and styles in `./styles/`
2. **Scripts persist via userScripts API** - Saved scripts register with Chrome's `userScripts` API (Chrome 120+) or Firefox's equivalent, bypassing CSP restrictions
3. **Auto-runs on matching URLs** - Scripts execute on page load for their saved URL patterns, including dynamic routes like `/products/[id]`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Browser Extension                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Background Service Worker                     │  │
│  │  • Claude API client (agentic loop)                       │  │
│  │  • userScripts registration & CSP bypass                  │  │
│  │  • Conversation history per tab                           │  │
│  │  • VFS storage coordination                               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↕                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Content Script                          │  │
│  │  • Virtual Filesystem (VFS) implementation                │  │
│  │  • DOM ↔ HTML serialization with version tracking         │  │
│  │  • Script execution in MAIN world                         │  │
│  │  • Console interception                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↕                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Sidebar Panel (React)                   │  │
│  │  • Chat UI with tool call visualization                   │  │
│  │  • Plan/Execute mode toggle                               │  │
│  │  • File browser & local sync                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Virtual Filesystem

Every website is presented as a virtual filesystem:

```
/{domain}/{url-path}/
├── page.html           # Live DOM (read/edit triggers mutations)
├── console.log         # Captured console output (read-only)
├── screenshot.png      # On-demand page capture
├── plan.md             # Agent's plan (plan mode)
├── scripts/
│   ├── my-script.js    # Your scripts (persisted, auto-run)
│   └── _auto_edits.js  # Generated from DOM edits
└── styles/
    └── custom.css      # Your styles (persisted, auto-injected)
```

### Version Tracking

Files have version numbers for optimistic concurrency control. The agent must read a file before editing, and provide the version from the read. If the DOM changed (user scrolled, JS mutated it), the edit fails with a version mismatch - forcing a re-read.

This prevents the agent from making changes based on stale data when editing a live page.

### Dynamic Route Matching

Scripts saved to paths like `/products/[id]` or `/docs/[...slug]` match dynamically:

| Pattern | Matches | `window.__routeParams` |
|---------|---------|------------------------|
| `/products/[id]` | `/products/123` | `{ id: "123" }` |
| `/users/[userId]/posts/[postId]` | `/users/5/posts/42` | `{ userId: "5", postId: "42" }` |
| `/docs/[...path]` | `/docs/api/auth/oauth` | `{ path: ["api", "auth", "oauth"] }` |

Route params are injected into `window.__routeParams` before your script runs.

## Plan/Execute Workflow

Browser Code uses a two-phase workflow for safety:

1. **Plan Mode** (default) - Agent explores the page, reads files, proposes changes to `plan.md`. Cannot mutate DOM or write scripts.
2. **Execute Mode** - After user approval, agent executes the plan. Can write files, edit DOM, run scripts.

This prevents the agent from making unintended changes while exploring.

## Local File Sync

Sync your userscripts bidirectionally with your local filesystem:

| Browser | Read | Write | API Used |
|---------|------|-------|----------|
| Chrome | ✓ | ✓ | File System Access API |
| Firefox | - | ✓ (export) | Downloads API |

**Chrome**: Select a directory once, then edits sync both ways. Edit in VS Code, see changes in browser.

**Firefox**: Export-only via Downloads API. Scripts download to your configured directory.

Conflict resolution: newest wins, or choose per-conflict.

## Agent Tools

The agent has filesystem-like tools:

| Tool | Description |
|------|-------------|
| **Read** | Read file content. Returns content + version for conflict detection. |
| **Edit** | Find-and-replace in a file. Requires version from last Read. |
| **Write** | Write entire file. Use version 0 for new files. |
| **Glob** | Find files matching a pattern (`./scripts/*.js`). |
| **Grep** | Search for regex in files. Returns matches with context. |
| **Bash** | Execute a script file (`./scripts/foo.js`) or inline JS. |
| **Ls** | List directory contents. |
| **Screenshot** | Capture current viewport. |
| **Todo** | Manage task list for multi-step operations. |

## Installation

### Chrome

1. Build the extension (see below) or download a release
2. Go to `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select `.output/chrome-mv3/`
5. Click extension **Details** → enable **User scripts** permission (required for CSP bypass)

### Firefox

1. Build the extension (see below)
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on** → select any file in `.output/firefox-mv2/`

## Building

```bash
bun install

# Development
bun run dev           # Chrome
bun run dev:firefox   # Firefox

# Production
bun run build         # Both browsers
bun run zip           # Create distribution zips
```

## Limitations

- **CSP bypass requires permission**: Sites like LinkedIn have strict CSP. Chrome's userScripts API bypasses this, but you must enable the "User scripts" permission in extension settings.
- **Trusted Types**: Some sites sanitize innerHTML. Scripts may need to use DOM APIs (`createElement`) instead.
- **Firefox sync is export-only**: No File System Access API in Firefox, so sync is one-way via Downloads.

## Technical Details

**Storage**: VFS data stored in `browser.storage.local` keyed by `vfs:{domain}`. Each domain has paths → scripts/styles.

**Script Registration**: On storage change, background script re-registers all scripts via `chrome.userScripts.register()` with match patterns derived from VFS paths.

**CSP Bypass**: userScripts API configures a custom world with permissive CSP: `script-src 'self' 'unsafe-inline' 'unsafe-eval'`.

**DOM Serialization**: `page.html` reads serialize the full document. Writes diff against current DOM and apply minimal mutations.
