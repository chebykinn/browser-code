import type { ReadInput, ReadResult } from '@/lib/types/tools';
import { getVFS } from '../vfs';

// Max characters to return (keep small to leave room for conversation history)
const MAX_CONTENT_LENGTH = 15000;

/**
 * Read file content from the virtual filesystem.
 * Returns content with version number for conflict detection.
 */
export async function read(input: ReadInput): Promise<ReadResult> {
  const { path, offset, limit } = input;
  const vfs = getVFS();

  console.log('[Read] Reading:', path, 'offset:', offset, 'limit:', limit);

  try {
    const result = await vfs.read(path, offset, limit);

    if ('code' in result) {
      console.log('[Read] Error:', result.message);
      return {
        success: false,
        path,
        error: result.message,
      };
    }

    console.log('[Read] Success: lines:', result.lines, 'chars:', result.content.length);

    // Check if content is too large
    if (result.content.length > MAX_CONTENT_LENGTH) {
      return {
        success: false,
        path: result.path,
        version: result.version,
        lines: result.lines,
        error: `File is too large (${result.content.length} chars, ${result.lines} lines). Use Grep tool to search for specific content, or use offset/limit params to read specific line ranges (e.g., offset: 0, limit: 200).`,
      };
    }

    return {
      success: true,
      path: result.path,
      content: result.content,
      version: result.version,
      lines: result.lines,
    };
  } catch (error) {
    console.error('[Read] Exception:', error);
    return {
      success: false,
      path,
      error: `Read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
