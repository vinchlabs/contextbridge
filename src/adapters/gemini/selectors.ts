/**
 * Centralized DOM selectors for Google Gemini (gemini.google.com)
 */

export const GEMINI_SELECTORS = {
  SCROLL_CONTAINERS: [
    'infinite-scroller',
    '.chat-history',
    'main [class*="scroll"]',
    'main',
  ],

  TURNS: {
    USER_QUERY: 'user-query, [data-test-id="user-query"], div[class*="user-query"]',
    MODEL_RESPONSE: 'model-response, [data-test-id="model-response"], div[class*="model-response"]',
    COMBINED_TURNS: 'user-query, model-response, [data-test-id="user-query"], [data-test-id="model-response"]',
  },

  CONTENT: {
    BODY: 'message-content, .message-content, .markdown, [class*="message-content"]',
    CODE_BLOCKS: 'code-block, pre, .code-block',
    TABLES: 'table',
    IMAGES: 'img[src]',
    CITATIONS: '.source-bubble, a.citation-anchor, [class*="source"] a',
  },

  COMPOSER: {
    INPUT: 'rich-textarea div[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea',
    FILE_INPUT: 'input[type="file"]',
    SEND_BUTTON: 'button[aria-label*="Send"], button.send-button',
  },

  METADATA: {
    TITLE: '.conversation-title, h1, [data-test-id="conversation-title"]',
  },
} as const;
