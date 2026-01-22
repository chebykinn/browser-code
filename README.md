# Browser Code

A coding agent that lives inside your browser. Think Claude Code, but for web pages.

> **Note:** This extension is heavily vibe coded. Don't have high expectations.


https://github.com/user-attachments/assets/bb5c1662-6350-4bbf-94d2-ceb07ea0acfc




## Overview

Browser Code lets you use AI to modify and automate web pages. It provides Claude with a virtual filesystem view of the current page, where the DOM becomes a file you can read, edit, and script against.

The agent can:
- Read and modify page HTML
- Create and execute JavaScript scripts
- Inject custom CSS styles
- Save scripts that auto-run on future visits

## Installation

### Chrome

1. Download/build the extension (`.output/chrome-mv3/` folder)
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `.output/chrome-mv3/` folder
5. Find "Browser Code" in the list and click **Details**
6. Scroll down and enable **Allow access to file URLs** (optional)
7. **Important:** Toggle ON the **User scripts** permission - this is required for scripts to run on sites with strict Content Security Policy (like LinkedIn)

### Firefox

1. Download/build the extension (`.output/firefox-mv2/` folder)
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on**
4. Select any file inside the `.output/firefox-mv2/` folder (e.g., `manifest.json`)

## Usage

### Opening the Sidebar

**Chrome:**
- Click the Browser Code extension icon in your toolbar
- The sidebar panel opens on the right side of the browser

**Firefox:**
- Click the Browser Code extension icon in your toolbar, or press `Ctrl+B` / `Cmd+B`
- The sidebar panel opens on the left side of the browser

### The Virtual Filesystem

Browser Code presents each website as a virtual filesystem:

```
/{domain}/
├── page.html           # The current page's DOM (live, editable)
├── scripts/
│   ├── my-script.js    # Your saved JavaScript files
│   └── _auto_edits.js  # Auto-generated from page edits
└── styles/
    └── custom.css      # Your saved CSS files
```

**Key concepts:**

- **`page.html`** - Reading it returns the current DOM as HTML. Editing it modifies the live page.
- **`scripts/*.js`** - JavaScript files you create. Execute with the Bash tool: `./scripts/my-script.js`
- **`styles/*.css`** - CSS files that are automatically injected when saved.
- **Version tracking** - Files have versions. You must read before editing to prevent conflicts.

### Agent Tools

The agent has access to these tools for interacting with the virtual filesystem:

| Tool | Description |
|------|-------------|
| **Read** | Read file content. Returns content with version number for conflict detection. Must read before editing. |
| **Edit** | Find and replace text in a file. Requires version from last Read. |
| **Write** | Write entire file content. Use version 0 for new files. |
| **Glob** | Find files matching a pattern (e.g., `./scripts/*.js`). |
| **Grep** | Search for text/regex in files. Returns matches with line numbers. |
| **GrepCount** | Count matches without returning content. Use before Grep to check result size. |
| **Bash** | Execute a script file (`./scripts/foo.js`) or inline JavaScript. |
| **Ls** | List directory contents. |

**Version tracking:** Every file has a version. You must Read before Edit/Write, and provide the version number. This prevents conflicts when the page changes.

### Example Prompts

- "Hide all ads on this page"
- "Change the background color to dark mode"
- "Create a script that extracts all links into a CSV"
- "Make the sidebar sticky"

### Saving Scripts

Scripts you create are saved per-domain and URL path. They automatically run when you revisit the same page. Use the **Files** button in the sidebar to browse, copy, or delete saved scripts.

### Exporting/Importing

In the Files panel, you can:
- **Export** all saved scripts across all domains to a JSON file
- **Import** previously exported scripts

## Building from Source

```bash
# Install dependencies
bun install

# Development (Chrome)
bun run dev

# Development (Firefox)
bun run dev:firefox

# Production build (both browsers)
bun run build

# Create zip files for distribution
bun run zip
```

## Limitations

- **Strict CSP sites (Chrome):** Sites like LinkedIn have strict Content Security Policies. The extension uses Chrome's userScripts API to bypass this, but you must enable the "User scripts" permission in extension settings.
- **Trusted Types:** Some sites (like LinkedIn) use Trusted Types which sanitize innerHTML. Scripts that inject HTML via innerHTML may need to use DOM APIs (createElement) instead.
