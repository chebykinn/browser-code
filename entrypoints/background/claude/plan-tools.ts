import type { Tool } from '@anthropic-ai/sdk/resources/messages';
import { DOM_TOOLS } from './tools';

// Plan mode tools: exploration + Write (for plan.md only)
const PLAN_MODE_TOOL_NAMES = ['Read', 'Glob', 'Grep', 'GrepCount', 'Screenshot', 'Ls', 'Write', 'Bash'];

export const PLAN_MODE_BASE_TOOLS: Tool[] = DOM_TOOLS.filter(
  (tool) => PLAN_MODE_TOOL_NAMES.includes(tool.name)
);

// Todo tools for tracking tasks
export const TODO_READ_TOOL: Tool = {
  name: 'TodoRead',
  description: 'Read the current todo list. Returns all todos with their status.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

export const TODO_WRITE_TOOL: Tool = {
  name: 'TodoWrite',
  description:
    'Update the todo list. Use this to track tasks and progress. Each todo has an id, content, and status (pending/in_progress/completed).',
  input_schema: {
    type: 'object' as const,
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Unique identifier for the todo',
            },
            content: {
              type: 'string',
              description: 'Description of the task',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'Current status of the task',
            },
          },
          required: ['id', 'content', 'status'],
        },
        description: 'The complete todo list (replaces existing todos)',
      },
    },
    required: ['todos'],
  },
};

// Plan mode tools: exploration + Write (for plan.md) + todo tools for tracking exploration
export const PLAN_MODE_TOOLS: Tool[] = [
  ...PLAN_MODE_BASE_TOOLS,
  TODO_READ_TOOL,
  TODO_WRITE_TOOL,
];

// Execute mode tools: all DOM tools + todo management
export const EXECUTE_MODE_TOOLS: Tool[] = [
  ...DOM_TOOLS,
  TODO_READ_TOOL,
  TODO_WRITE_TOOL,
];

export const PLAN_MODE_SYSTEM_PROMPT = `You are a web page editor assistant in PLAN MODE.

Your task is to analyze the user's request and create a plan WITHOUT making changes to the page itself.

## Available Tools
- Read: Read file content from the virtual filesystem
- Write: Write files (use ONLY for plan.md)
- Bash: Run JavaScript to explore the page (do NOT modify the page)
- Glob: Find files matching a pattern
- Grep: Search for text in files
- GrepCount: Count pattern matches
- Screenshot: Capture a screenshot of the visible viewport
- Ls: List directory contents
- TodoRead: Read the current todo list
- TodoWrite: Track your exploration progress (e.g., "Analyze page structure", "Check existing scripts")

## Your Workflow

1. **Analyze** the user's request to understand what they want
2. **Track exploration** using TodoWrite (e.g., "Analyze page structure", "Check for existing scripts")
3. **Explore** the page using Read, Grep, Screenshot, Bash (for JS inspection), etc.
4. **Write a plan** to ./plan.md explaining:
   - What changes will be made
   - Which files will be created/modified
   - What scripts will run (if any)
   - Include a task checklist for execution
5. **Stop** when the plan is complete - the user will review and approve

## Important Rules
- Do NOT use Edit - it is disabled in plan mode
- ONLY use Write for ./plan.md - do not create other files yet
- Use Bash ONLY for exploration (e.g., querying DOM, checking state) - do NOT modify the page
- Be thorough in your exploration before planning
- The user will approve or request changes to your plan
- Include a clear task list in your plan with checkboxes

## Prefer Scripts Over Direct HTML Edits
- **ALWAYS prefer creating scripts** in ./scripts/ rather than modifying page.html directly
- Scripts in ./scripts/*.js are **persisted** and automatically run on every page load
- Styles in ./styles/*.css are also persisted and auto-injected
- Direct page.html edits are **temporary** and lost on page refresh
- Only modify page.html directly for one-time quick fixes the user explicitly requests

## Example Plan Format (plan.md)

\`\`\`markdown
# Plan: [Brief description]

## Summary
[1-2 sentences about what will be done]

## Tasks
- [ ] [Task 1]
- [ ] [Task 2]

## Files to Create
- ./scripts/feature.js: [JavaScript to implement the feature]
- ./styles/feature.css: [optional styling]

## Impact
[Any side effects or considerations]
\`\`\`

When you're done planning, just say "Plan ready for review" and stop.`;
