import { z } from 'zod';

// Tool input schemas - VFS-based
export const ReadInputSchema = z.object({
  path: z.string().describe('File path (e.g., "/example.com/page.html", "./scripts/foo.js")'),
  offset: z.number().optional().describe('Start from line number (0-indexed)'),
  limit: z.number().optional().describe('Max lines to return'),
});

export const EditInputSchema = z.object({
  path: z.string().describe('File path'),
  old_string: z.string().describe('Text to find and replace'),
  new_string: z.string().describe('Replacement text'),
  expectedVersion: z.number().describe('Version from last Read (required)'),
  replace_all: z.boolean().optional().describe('Replace all occurrences (default: false)'),
});

export const WriteInputSchema = z.object({
  path: z.string().describe('File path'),
  content: z.string().describe('New file content'),
  expectedVersion: z.number().describe('Version from last Read (0 for new files)'),
});

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g., "/example.com/scripts/*.js")'),
  path: z.string().optional().describe('Base directory'),
});

export const GrepInputSchema = z.object({
  pattern: z.string().describe('Text or regex pattern to search'),
  path: z.string().optional().describe('File or directory to search (defaults to page.html)'),
  context_lines: z.number().optional().describe('Lines of context around match'),
});

export const BashInputSchema = z.object({
  command: z.string().describe('Script path (./scripts/foo.js) or inline JavaScript'),
});

export const LsInputSchema = z.object({
  path: z.string().optional().describe('Directory path (defaults to current domain root)'),
});

export const ScreenshotInputSchema = z.object({
  format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
  quality: z.number().min(0).max(100).optional().describe('JPEG quality 0-100 (only for jpeg format)'),
});

// Infer types from schemas
export type ReadInput = z.infer<typeof ReadInputSchema>;
export type EditInput = z.infer<typeof EditInputSchema>;
export type WriteInput = z.infer<typeof WriteInputSchema>;
export type GlobInput = z.infer<typeof GlobInputSchema>;
export type GrepInput = z.infer<typeof GrepInputSchema>;
export type BashInput = z.infer<typeof BashInputSchema>;
export type LsInput = z.infer<typeof LsInputSchema>;
export type ScreenshotInput = z.infer<typeof ScreenshotInputSchema>;

// Tool result types - VFS-based
export interface ReadResult {
  success: boolean;
  path: string;
  content?: string;
  version?: number;
  lines?: number;
  error?: string;
}

export interface EditResult {
  success: boolean;
  path: string;
  version?: number;
  replacements?: number;
  error?: string;
}

export interface WriteResult {
  success: boolean;
  path: string;
  version?: number;
  error?: string;
}

export interface GlobResult {
  matches: string[];
  count: number;
}

export interface GrepResult {
  matches: Array<{
    path: string;
    line: number;
    content: string;
    match: string;
    context?: string;
  }>;
  count: number;
  error?: string;
  truncated?: boolean;
  message?: string;
}

export interface GrepCountResult {
  count: number;
  path: string;
}

export interface BashResult {
  success: boolean;
  output?: string;
  result?: unknown;
  error?: string;
}

export interface LsResult {
  entries: Array<{
    name: string;
    path: string;
    type: 'file' | 'directory';
    version?: number;
    modified?: number;
  }>;
  path: string;
}

export interface ScreenshotResult {
  success: boolean;
  path?: string;
  version?: number;
  format?: 'png' | 'jpeg';
  error?: string;
}

// Union type for tool inputs
export type ToolInput =
  | { name: 'Read'; input: ReadInput }
  | { name: 'Edit'; input: EditInput }
  | { name: 'Write'; input: WriteInput }
  | { name: 'Glob'; input: GlobInput }
  | { name: 'Grep'; input: GrepInput }
  | { name: 'Bash'; input: BashInput }
  | { name: 'Ls'; input: LsInput }
  | { name: 'Screenshot'; input: ScreenshotInput };

// Union type for tool results
export type ToolResult =
  | ReadResult
  | EditResult
  | WriteResult
  | GlobResult
  | GrepResult
  | GrepCountResult
  | BashResult
  | LsResult
  | ScreenshotResult;
