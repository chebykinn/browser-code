/**
 * Playwright fixtures for browser extension E2E tests.
 *
 * Provides:
 *   - `context`      — Chromium browser context with the extension loaded
 *   - `extensionId`  — Chrome extension ID (extracted from the service worker URL)
 *   - `mockPort`     — Port number of the running mock Anthropic server
 *   - `setupMock`    — Configure mock responses for a test
 *   - `setupStorage` — Write extension storage values (API key + mock URL)
 */

import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer, type MockServer } from './mock-server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '../../.output/chrome-mv3');
const MOCK_PORT = 4242;

export interface StorageValues {
  /** @example "sk-ant-test-key" */
  apiKey?: string;
  model?: string;
  enabled?: boolean;
}

interface Fixtures {
  context: BrowserContext;
  extensionId: string;
  mockPort: number;
  setupMock: (responses: object[]) => Promise<void>;
  setupStorage: (values?: StorageValues) => Promise<void>;
  /** Ready-to-use sidepanel page with storage pre-configured */
  sidepanel: Page;
}

export const test = base.extend<Fixtures>({
  // One mock server per worker (tests run with workers: 1)
  mockPort: [
    async ({}, use) => {
      let server: MockServer | undefined;
      server = await startMockServer(MOCK_PORT);
      await use(MOCK_PORT);
      server.close();
    },
    { scope: 'worker' },
  ],

  context: [
    async ({}, use) => {
      const context = await chromium.launchPersistentContext('', {
        headless: false,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          // New headless mode supports extensions in Chrome 112+
          '--headless=new',
          '--no-sandbox',
        ],
      });
      await use(context);
      await context.close();
    },
    { scope: 'test' },
  ],

  extensionId: async ({ context }, use) => {
    // Wait for the extension's service worker to register
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker');
    }
    // URL format: chrome-extension://<id>/background.js
    const extensionId = background.url().split('/')[2];
    await use(extensionId);
  },

  setupMock: async ({ mockPort }, use) => {
    const helper = async (responses: object[]) => {
      const res = await fetch(`http://localhost:${mockPort}/test/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responses }),
      });
      if (!res.ok) throw new Error(`Mock setup failed: ${res.status}`);
    };
    await use(helper);
  },

  setupStorage: async ({ context, mockPort }, use) => {
    const helper = async (values: StorageValues = {}) => {
      // Wait for the service worker to be ready
      let [background] = context.serviceWorkers();
      if (!background) {
        background = await context.waitForEvent('serviceworker');
      }
      const port = mockPort;
      await background.evaluate(
        ({ storageValues, mockBaseURL }: { storageValues: StorageValues; mockBaseURL: string }) => {
          return new Promise<void>((resolve) => {
            chrome.storage.local.set(
              {
                settings: {
                  // Dummy key — requests go to mock server, not the real Anthropic API
                  apiKey: 'sk-ant-test-key',
                  model: 'claude-opus-4-5-20251101',
                  enabled: true,
                  ...storageValues,
                },
                _testBaseURL: mockBaseURL,
              },
              resolve,
            );
          });
        },
        { storageValues: values, mockBaseURL: `http://localhost:${port}` },
      );
    };
    await use(helper);
  },

  sidepanel: async ({ context, extensionId, setupStorage }, use) => {
    // Configure extension storage with test credentials before opening the UI
    await setupStorage();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    // Wait until the sidepanel detects its tab ID (which enables the send button)
    await page.waitForSelector('[data-testid="send-button"]:not([disabled])', {
      timeout: 10_000,
    });
    await use(page);
  },
});

export { expect } from '@playwright/test';
