import { ClaudeAdapter } from '../src/adapters/claude/adapter';
import { registerContentScriptMessaging } from '../src/utils/content-messaging';

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  runAt: 'document_idle',
  main() {
    registerContentScriptMessaging(new ClaudeAdapter(), {
      platformId: 'claude',
      countVisibleMessages: () =>
        document.querySelectorAll('[data-testid="user-message"], div[class*="font-claude-message"]').length,
    });
  },
});
