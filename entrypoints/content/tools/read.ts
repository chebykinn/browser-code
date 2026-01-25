import type { ReadInput, ReadResult, ImageMediaType } from '@/lib/types/tools';
import { getVFS } from '../vfs';

// Max characters to return (keep small to leave room for conversation history)
const MAX_CONTENT_LENGTH = 15000;

// Supported image media types
const SUPPORTED_IMAGE_TYPES: ImageMediaType[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * Parse a data URL and extract base64 data and media type.
 */
function parseDataUrl(dataUrl: string): { data: string; mediaType: ImageMediaType } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;

  const mediaType = match[1] as ImageMediaType;
  // Only return if it's a supported image type
  if (!SUPPORTED_IMAGE_TYPES.includes(mediaType)) return null;

  return {
    mediaType,
    data: match[2],
  };
}

/**
 * Check if a path is a screenshot file.
 */
function isScreenshotPath(path: string): boolean {
  return path.endsWith('/screenshot.png') || path.endsWith('/screenshot.jpeg') || path.endsWith('/screenshot.jpg');
}

/**
 * Read file content from the virtual filesystem.
 * Returns content with version number for conflict detection.
 * For screenshots, returns image data instead of content.
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

    // Handle screenshots specially - return as image data
    if (isScreenshotPath(path) && result.content.startsWith('data:image/')) {
      const parsed = parseDataUrl(result.content);
      if (parsed) {
        console.log('[Read] Screenshot detected, returning as image data');
        return {
          success: true,
          path: result.path,
          version: result.version,
          image: {
            data: parsed.data,
            mediaType: parsed.mediaType,
          },
        };
      }
    }

    // Check if content is too large (skip for images which are handled above)
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
