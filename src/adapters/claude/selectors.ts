/**
 * Centralized DOM selectors for Claude (claude.ai)
 */

export const CLAUDE_SELECTORS = {
  SCROLL_CONTAINERS: [
    'main [class*="overflow-y-auto"]',
    'main',
    'div[class*="overflow-y-auto"]',
  ],

  TURNS: {
    USER: '[data-testid="user-message"], div[class*="font-user-message"], div[class*="user-message"]',
    ASSISTANT: 'div[class*="font-claude-message"], [data-testid*="claude-message"], div[class*="claude-message"]',
    COMBINED: '[data-testid="user-message"], div[class*="font-claude-message"], div[class*="user-message"], div[class*="claude-message"]',
  },

  CONTENT: {
    PROSE: '.prose, div[class*="prose"]',
    CODE_BLOCKS: 'pre, pre code',
    ARTIFACTS: '[data-testid*="artifact"], div[class*="artifact"]',
    TABLES: 'table',
    IMAGES: 'img[src]',
    ATTACHMENTS: '[data-testid*="attachment"], div[class*="attachment"]',
  },

  COMPOSER: {
    INPUT: 'div[contenteditable="true"], fieldset div[contenteditable="true"], div[role="textbox"]',
    FILE_INPUT: 'input[type="file"]',
    SEND_BUTTON: 'button[aria-label="Send Message"], button[data-testid="send-button"]',
  },

  METADATA: {
    TITLE: '[data-testid="chat-title"], h1, button[data-testid="chat-title-button"]',
  },
} as const;
