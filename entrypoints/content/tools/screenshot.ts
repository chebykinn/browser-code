import type { ScreenshotInput, ScreenshotResult } from '@/lib/types/tools';
import { getVFS } from '../vfs';

/**
 * Capture a screenshot of the current visible viewport.
 * The screenshot is saved to the VFS and can be read via the Read tool.
 */
export async function screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
  const format = input.format || 'png';
  const quality = input.quality;

  try {
    // Request screenshot from background script
    const response = await browser.runtime.sendMessage({
      type: 'CAPTURE_SCREENSHOT',
      format,
      quality,
    }) as { success: boolean; dataUrl?: string; error?: string };

    if (!response.success || !response.dataUrl) {
      return {
        success: false,
        error: response.error || 'Failed to capture screenshot',
      };
    }

    // Save to VFS storage
    const vfs = getVFS();
    const cwd = vfs.getCwd();
    const urlPath = new URL(window.location.href).pathname;

    // Access storage directly to save screenshot
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = (vfs as any).storage;
    const screenshotData = storage.saveScreenshot(urlPath, response.dataUrl, format);

    return {
      success: true,
      path: `${cwd}/screenshot.png`,
      version: screenshotData.version,
      format,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
