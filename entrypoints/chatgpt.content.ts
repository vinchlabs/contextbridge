import { ChatGPTAdapter } from '../src/adapters/chatgpt/adapter';
import { CHATGPT_SELECTORS } from '../src/adapters/chatgpt/selectors';
import { findActiveThreadRoot, queryActiveThread } from '../src/adapters/chatgpt/active-thread';
import { registerContentScriptMessaging } from '../src/utils/content-messaging';

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  runAt: 'document_idle',
  main() {
    registerContentScriptMessaging(new ChatGPTAdapter(), {
      platformId: 'chatgpt',
      countVisibleMessages: () => {
        // Count only the thread on screen (hidden app-shell pages stay mounted).
        const root = findActiveThreadRoot(document);
        const count = (sel: string) => queryActiveThread(root, sel).length;
        const primaryTurns = count(CHATGPT_SELECTORS.TURNS.PRIMARY);
        const units = count(CHATGPT_SELECTORS.UNITS.PRIMARY) || count(CHATGPT_SELECTORS.UNITS.FALLBACK);
        const fallbackTurns =
          count(CHATGPT_SELECTORS.TURNS.FALLBACK_ARTICLE) || count(CHATGPT_SELECTORS.TURNS.FALLBACK_TESTID);
        return units > 0 ? units : primaryTurns > 0 ? primaryTurns : fallbackTurns;
      },
    });
  },
});
