import { executeTool } from './tools';
import { getVFS } from './vfs';
import { getConsoleCollector } from './console/collector';
import type { BackgroundToContentMessage } from '@/lib/types/messages';

export default defineContentScript({
  matches: ['<all_urls>'],

  async main() {
    console.log('[Page Editor] Content script loaded on:', window.location.href);

    // Initialize console collector to receive messages from interceptor
    getConsoleCollector().init();

    // Initialize VFS and run auto-edits/styles
    const vfs = getVFS();
    await vfs.runAutoEdits();

    // Listen for messages from background script
    browser.runtime.onMessage.addListener(
      (message: BackgroundToContentMessage, _sender, sendResponse) => {
        console.log('[Page Editor] Content script received message:', message.type);
        handleMessage(message)
          .then((result) => {
            console.log('[Page Editor] Content script sending response:', result);
            sendResponse(result);
          })
          .catch((error) => {
            console.error('[Page Editor] Error handling message:', error);
            sendResponse({ error: error.message });
          });

        // Return true to indicate we will send response asynchronously
        return true;
      }
    );
  },
});

async function handleMessage(message: BackgroundToContentMessage): Promise<unknown> {
  const vfs = getVFS();

  switch (message.type) {
    case 'EXECUTE_TOOL': {
      console.log('[Page Editor] Executing tool:', message.tool, message.input);
      const result = await executeTool(message.tool, message.input);
      console.log('[Page Editor] Tool result:', result);
      return {
        toolCallId: message.toolCallId,
        result,
      };
    }

    case 'GET_VFS_FILES': {
      const scriptsResult = await vfs.listScripts();
      const stylesResult = await vfs.listStyles();
      return {
        scripts: scriptsResult.files,
        styles: stylesResult.files,
        scriptsMatchedPattern: scriptsResult.matchedPattern,
        stylesMatchedPattern: stylesResult.matchedPattern,
      };
    }

    case 'DELETE_VFS_FILE': {
      const success = await vfs.deleteFile(message.fileType, message.fileName);
      return { success };
    }

    case 'INVALIDATE_VFS_CACHE': {
      vfs.invalidateCache();
      return { success: true };
    }

    default:
      throw new Error(`Unknown message type: ${(message as { type: string }).type}`);
  }
}
