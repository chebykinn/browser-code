import type { WriteInput, WriteResult } from '@/lib/types/tools';
import { getVFS } from '../vfs';

/**
 * Write content to a file in the virtual filesystem.
 * Requires expectedVersion from last Read for conflict detection.
 */
export async function write(input: WriteInput): Promise<WriteResult> {
  const { path, content, expectedVersion } = input;
  const vfs = getVFS();

  const result = await vfs.write(path, content, expectedVersion);

  if ('code' in result) {
    // Error result
    return {
      success: false,
      path,
      error: result.message,
    };
  }

  return {
    success: true,
    path,
    version: result.version,
  };
}
