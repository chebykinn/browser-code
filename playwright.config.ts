import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  // Run tests serially to avoid mock server port conflicts
  workers: 1,
  use: {
    // Extensions require non-headless (or --headless=new) — set in fixture
    headless: false,
  },
});
