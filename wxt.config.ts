import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  suppressWarnings: {
    firefoxDataCollection: true,
  },
  vite: () => ({
    build: {
      chunkSizeWarningLimit: 1200,
    },
  }),
  manifest: {
    name: 'ContextBridge',
    description: 'Local-first conversation handoff between AI chat applications (ChatGPT, Gemini, Claude).',
    version: '1.0.0',
    permissions: [
      'storage',
      'downloads',
      'activeTab',
      'scripting',
    ],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://*.oaiusercontent.com/*',
      'https://*.openai.com/*',
      'https://gemini.google.com/*',
      // Gemini serves uploaded/generated images from googleusercontent.com
      'https://*.googleusercontent.com/*',
      'https://claude.ai/*',
    ],
    // libsodium (archive encryption) instantiates WebAssembly in the popup; Firefox MV3 extension
    // pages block it unless 'wasm-unsafe-eval' is allowed explicitly.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    browser_specific_settings: {
      gecko: {
        id: 'contextbridge@local',
        strict_min_version: '115.0',
      },
    },
  },
});
