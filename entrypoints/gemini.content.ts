import { GeminiAdapter } from '../src/adapters/gemini/adapter';
import { registerContentScriptMessaging } from '../src/utils/content-messaging';

export default defineContentScript({
  matches: ['https://gemini.google.com/*'],
  runAt: 'document_idle',
  main() {
    registerContentScriptMessaging(new GeminiAdapter(), {
      platformId: 'gemini',
      countVisibleMessages: () => document.querySelectorAll('user-query, model-response').length,
    });
  },
});
