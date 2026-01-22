import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'Browser Code',
    description: 'Edit web pages with AI assistance - Claude Code for the browser',
    version: '0.1.0',
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      ...(browser === 'chrome' ? ['sidePanel', 'userScripts'] : []),
    ],
    host_permissions: ['<all_urls>'],
    // Firefox: use sidebar_action for sidebar panel
    ...(browser === 'firefox' && {
      sidebar_action: {
        default_panel: 'sidepanel.html',
        default_title: 'Browser Code',
      },
      browser_specific_settings: {
        gecko: {
          id: 'browser-code@extension',
          strict_min_version: '109.0',
        },
      },
      // Firefox MV2 allows unsafe-eval
      content_security_policy: "script-src 'self' 'unsafe-eval'; object-src 'self'",
    }),
  }),
});
