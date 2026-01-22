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
      // Chrome: userScripts is install-time permission
      // Firefox: userScripts must be in optional_permissions
      ...(browser === 'chrome' ? ['sidePanel', 'userScripts'] : []),
    ],
    // Firefox MV3: userScripts must be optional and requested at runtime
    ...(browser === 'firefox' && {
      optional_permissions: ['userScripts'],
    }),
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
          strict_min_version: '128.0',
        },
      },
    }),
  }),
});
