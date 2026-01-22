import type { GlobInput, GlobResult } from '@/lib/types/tools';
import { getVFS } from '../vfs';

/**
 * Find files matching a glob pattern in the virtual filesystem.
 */
export async function glob(input: GlobInput): Promise<GlobResult> {
  const { pattern, path } = input;
  const vfs = getVFS();

  // If path is provided, combine with pattern
  let searchPattern = pattern;
  if (path) {
    searchPattern = `${path}/${pattern}`.replace(/\/+/g, '/');
  }

  const matches = await vfs.glob(searchPattern);

  return {
    matches,
    count: matches.length,
  };
}
