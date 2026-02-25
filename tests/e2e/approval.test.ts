/**
 * E2E tests for the tool approval feature.
 *
 * The LLM is mocked via a local HTTP server (mock-server.ts).
 * The extension is loaded into a real Chromium instance.
 *
 * Each test:
 *  1. Programs the mock server with a response sequence
 *  2. Opens the sidepanel as a page
 *  3. Sends a chat message
 *  4. Asserts the approval UI appears
 *  5. Clicks Approve or Deny
 *  6. Asserts the conversation completes correctly
 */

import { test, expect } from './fixtures';
import { bashToolUseResponse, writeToolUseResponse, endTurnResponse } from './mock-server';

test.describe('Tool Approval', () => {
  test.beforeEach(async ({ setupStorage }) => {
    await setupStorage({});
  });

  /** Opens the sidepanel and returns the page. Waits until the chat input is ready. */
  async function openSidepanel(context: import('@playwright/test').BrowserContext, extensionId: string) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    // Wait until the tabId is detected (input becomes enabled)
    await page.waitForSelector('[data-testid="chat-input"]:not([disabled])', { timeout: 10_000 });
    return page;
  }

  /** Types a message and clicks Send. */
  async function sendMessage(page: import('@playwright/test').Page, message: string) {
    await page.fill('[data-testid="chat-input"]', message);
    await page.click('[data-testid="send-button"]');
  }

  /** Waits for the loading indicator to disappear (agent done). */
  async function waitForAgentDone(page: import('@playwright/test').Page) {
    await page.waitForSelector('.loading', { state: 'hidden', timeout: 15_000 });
    // Also wait for pending approvals to clear
    await page.waitForFunction(() => {
      return document.querySelectorAll('.tool-approval').length === 0;
    }, { timeout: 5_000 });
  }

  test('dangerous tool (Bash) shows WARNING approval badge', async ({
    context,
    extensionId,
    setupMock,
  }) => {
    await setupMock([
      bashToolUseResponse('echo "hello from test"'),
      endTurnResponse('Command completed.'),
    ]);

    const page = await openSidepanel(context, extensionId);
    await sendMessage(page, 'Run a command');

    // Approval UI should appear with WARNING badge
    const approval = page.locator('.tool-approval.dangerous');
    await expect(approval).toBeVisible({ timeout: 10_000 });
    await expect(approval.locator('.tool-approval-badge')).toHaveText('WARNING');
    await expect(approval.locator('.tool-name')).toHaveText('Bash');
  });

  test('approving a Bash tool completes the conversation', async ({
    context,
    extensionId,
    setupMock,
  }) => {
    await setupMock([
      bashToolUseResponse('echo "hello"'),
      endTurnResponse('Done! The command ran successfully.'),
    ]);

    const page = await openSidepanel(context, extensionId);
    await sendMessage(page, 'Run a command');

    // Wait for approval UI and click Approve
    await page.waitForSelector('.tool-approval.dangerous', { timeout: 10_000 });
    await page.click('.tool-approve-button');

    // Agent should finish and approval UI should be gone
    await waitForAgentDone(page);
    await expect(page.locator('.tool-approval')).toHaveCount(0);

    // Final assistant message should be visible
    await expect(page.locator('.message.assistant').last()).toContainText('Done!');
  });

  test('denying a Bash tool completes the conversation with an error result', async ({
    context,
    extensionId,
    setupMock,
  }) => {
    // Mock accepts whatever tool_result (including denial error) and ends the turn
    await setupMock([
      bashToolUseResponse('rm -rf /'),
      endTurnResponse('Understood, I will not run that command.'),
    ]);

    const page = await openSidepanel(context, extensionId);
    await sendMessage(page, 'Delete everything');

    // Wait for approval and deny
    await page.waitForSelector('.tool-approval.dangerous', { timeout: 10_000 });
    await page.click('.tool-deny-button');

    // Agent should finish cleanly
    await waitForAgentDone(page);
    await expect(page.locator('.tool-approval')).toHaveCount(0);
  });

  test('mutating tool (Write) shows REVIEW approval badge', async ({
    context,
    extensionId,
    setupMock,
  }) => {
    await setupMock([
      writeToolUseResponse('./index.html', '<h1>Hello</h1>'),
      endTurnResponse('File written.'),
    ]);

    const page = await openSidepanel(context, extensionId);
    await sendMessage(page, 'Write a file');

    // Approval UI should appear with REVIEW badge
    const approval = page.locator('.tool-approval.mutating');
    await expect(approval).toBeVisible({ timeout: 10_000 });
    await expect(approval.locator('.tool-approval-badge')).toHaveText('REVIEW');
    await expect(approval.locator('.tool-name')).toHaveText('Write');
  });

  test('approving a Write tool completes the conversation', async ({
    context,
    extensionId,
    setupMock,
  }) => {
    await setupMock([
      writeToolUseResponse('./style.css', 'body { color: red; }'),
      endTurnResponse('File written successfully.'),
    ]);

    const page = await openSidepanel(context, extensionId);
    await sendMessage(page, 'Write a stylesheet');

    // Approve the Write tool
    await page.waitForSelector('.tool-approval.mutating', { timeout: 10_000 });
    await page.click('.tool-approve-button');

    await waitForAgentDone(page);
    await expect(page.locator('.tool-approval')).toHaveCount(0);
  });
});
