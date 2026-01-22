import type { BashInput, BashResult } from '@/lib/types/tools';
import { getVFS, executeInPageContext } from '../vfs';

const MAX_OUTPUT_LENGTH = 5000;

/**
 * Execute a script file or inline JavaScript.
 * - If command starts with "./" → execute that script file
 * - Otherwise → execute as inline JavaScript
 */
export async function bash(input: BashInput): Promise<BashResult> {
  const { command } = input;
  const vfs = getVFS();

  try {
    // Check if it's a script file path
    if (command.startsWith('./') || command.startsWith('/')) {
      const result = await vfs.exec(command);

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      return {
        success: true,
        output: formatResult(result.result),
        result: result.result,
      };
    }

    // Execute as inline JavaScript via script tag injection (bypasses CSP)
    const result = executeInPageContext(command);

    return {
      success: true,
      output: formatResult(result),
      result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Format execution result as string
 */
function formatResult(result: unknown): string {
  let output: string;

  if (result === undefined) {
    output = 'undefined';
  } else if (result === null) {
    output = 'null';
  } else if (typeof result === 'object') {
    try {
      output = JSON.stringify(result, null, 2);
    } catch {
      output = String(result);
    }
  } else {
    output = String(result);
  }

  // Truncate if too long
  if (output.length > MAX_OUTPUT_LENGTH) {
    output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n... [output truncated]';
  }

  return output;
}
