import type { GrepInput, GrepResult } from '@/lib/types/tools';
import { getVFS } from '../vfs';

const MAX_TOTAL_SIZE = 15000;
const MAX_MATCHES = 30;
const MAX_LINE_LENGTH = 200;

/**
 * Search for text/pattern in files.
 * Like grep - finds matches with context.
 */
export async function grep(input: GrepInput): Promise<GrepResult> {
  const { pattern, path, context_lines = 0 } = input;
  const vfs = getVFS();

  console.log('[Grep] Searching for:', pattern, 'in:', path || 'page.html');

  try {
    const allMatches = await vfs.grep(pattern, path, context_lines);
    console.log('[Grep] Found matches:', allMatches.length);

    // Limit matches
    const limitedMatches = allMatches.slice(0, MAX_MATCHES);

    // Truncate long lines
    const matches = limitedMatches.map(m => ({
      ...m,
      content: m.content.length > MAX_LINE_LENGTH
        ? m.content.slice(0, MAX_LINE_LENGTH) + '...'
        : m.content,
      context: m.context && m.context.length > MAX_LINE_LENGTH * 3
        ? m.context.slice(0, MAX_LINE_LENGTH * 3) + '...'
        : m.context,
    }));

    // Check total size
    const resultStr = JSON.stringify(matches);
    if (resultStr.length > MAX_TOTAL_SIZE) {
      // Return just line numbers and truncated content
      const minimalMatches = matches.map(m => ({
        path: m.path,
        line: m.line,
        match: m.match,
        content: m.content.slice(0, 100) + (m.content.length > 100 ? '...' : ''),
      }));

      return {
        matches: minimalMatches as typeof matches,
        count: allMatches.length,
        truncated: true,
        message: `Results truncated due to size. Showing ${minimalMatches.length} of ${allMatches.length} matches with shortened content. Use a more specific pattern.`,
      };
    }

    const wasTruncated = allMatches.length > MAX_MATCHES;
    return {
      matches,
      count: allMatches.length,
      truncated: wasTruncated,
      message: wasTruncated
        ? `Showing ${matches.length} of ${allMatches.length} matches. Use a more specific pattern to see all results.`
        : undefined,
    };
  } catch (error) {
    console.error('[Grep] Error:', error);
    return {
      matches: [],
      count: 0,
      error: `Grep failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Count matches without returning content.
 * Like grep -c - just returns the count.
 */
export async function grepCount(input: GrepInput): Promise<{ count: number; path: string }> {
  const { pattern, path } = input;
  const vfs = getVFS();

  const matches = await vfs.grep(pattern, path, 0);

  return {
    count: matches.length,
    path: path || 'page.html',
  };
}
