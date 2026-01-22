import type { LsInput, LsResult } from '@/lib/types/tools';
import { getVFS } from '../vfs';

/**
 * List directory contents in the virtual filesystem.
 */
export async function ls(input: LsInput): Promise<LsResult> {
  const { path } = input;
  const vfs = getVFS();

  const entries = await vfs.ls(path);

  return {
    entries,
    path: path || vfs.getCwd(),
  };
}
