import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'Browser Code',
    description: 'Edit web pages with AI assistance - Claude Code for the browser',
    version: '0.1.1',
    permissions: [
      'storage',
      'activeTab',
      'scripting',
      'downloads',
      // Chrome: userScripts is install-time permission
      // Firefox: userScripts must be in optional_permissions
      ...(browser === 'chrome' ? ['sidePanel', 'userScripts'] : []),
    ],
    // Firefox MV3: userScripts must be in optional_permissions
    ...(browser === 'firefox' && {
      optional_permissions: ['userScripts'],
    }),
    // file:///* only works on Chrome (Firefox blocks it - CVE-2020-6809)
    host_permissions: ['<all_urls>', ...(browser === 'chrome' ? ['file:///*'] : [])],
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
          data_collection_permissions: {
            required: ['none'],
          },
        },
      },
    }),
  }),
});
