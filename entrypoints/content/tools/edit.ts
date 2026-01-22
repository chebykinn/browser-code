import type { EditInput, EditResult } from '@/lib/types/tools';
import { getVFS } from '../vfs';

/**
 * Find and replace text in a file.
 * Requires expectedVersion from last Read for conflict detection.
 */
export async function edit(input: EditInput): Promise<EditResult> {
  const { path, old_string, new_string, expectedVersion, replace_all = false } = input;
  const vfs = getVFS();

  const result = await vfs.edit(path, old_string, new_string, expectedVersion, replace_all);

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
    replacements: result.replacements,
  };
}
