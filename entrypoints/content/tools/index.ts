import { read } from './read';
import { edit } from './edit';
import { write } from './write';
import { glob } from './glob';
import { grep, grepCount } from './grep';
import { bash } from './bash';
import { ls } from './ls';
import { screenshot } from './screenshot';
import type { ToolResult } from '@/lib/types/tools';

export { read, edit, write, glob, grep, grepCount, bash, ls, screenshot };

/**
 * Execute a tool by name with given input
 */
export async function executeTool(name: string, input: unknown): Promise<ToolResult> {
  switch (name) {
    case 'Read':
      return read(input as Parameters<typeof read>[0]);
    case 'Edit':
      return edit(input as Parameters<typeof edit>[0]);
    case 'Write':
      return write(input as Parameters<typeof write>[0]);
    case 'Glob':
      return glob(input as Parameters<typeof glob>[0]);
    case 'Grep':
      return grep(input as Parameters<typeof grep>[0]);
    case 'GrepCount':
      return grepCount(input as Parameters<typeof grepCount>[0]);
    case 'Bash':
      return bash(input as Parameters<typeof bash>[0]);
    case 'Ls':
      return ls(input as Parameters<typeof ls>[0]);
    case 'Screenshot':
      return screenshot(input as Parameters<typeof screenshot>[0]);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
