/**
 * Centralized DOM selectors for ChatGPT (chatgpt.com & chat.openai.com)
 * Updated for the live virtualized DOM (2026-09-28) with robust semantic attributes
 * and legacy fallbacks.
 */

export const CHATGPT_SELECTORS = {
  // Main scroll containers (virtual scroller container, react-scroll-to-bottom, overflow containers)
  SCROLL_CONTAINERS: [
    '[data-app-action-timeline-scroll]',
    '[data-virtualized-turn-content]',
    'main div[class*="react-scroll-to-bottom"]',
    'div[class*="react-scroll-to-bottom"]',
    'main [class*="overflow-y-auto"]',
    'main [class*="overflow-auto"]',
    '[class*="overflow-y-auto"]',
    'main',
  ],

  // Message turn elements
  TURNS: {
    PRIMARY: '[data-turn-key]',
    FALLBACK_ARTICLE: 'article',
    FALLBACK_TESTID: '[data-testid^="conversation-turn-"]',
    FALLBACK_ROLE: '[data-message-author-role]',
    // Backward-compat aliases:
    SECONDARY: '[data-testid^="conversation-turn-"]',
    FALLBACK: '[data-message-author-role]',
  },

  // Units within a turn (each turn may contain multiple semantic units)
  UNITS: {
    PRIMARY: '[data-content-search-unit-key]',
    FALLBACK: '[data-chatgpt-search-unit-key]',
    USER_FILTER: '[data-content-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":user"]',
    ASSISTANT_FILTER: '[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]',
  },

  // Author role detection (legacy attributes)
  ROLES: {
    ATTRIBUTE: '[data-message-author-role]',
    USER_ATTR_VAL: 'user',
    ASSISTANT_ATTR_VAL: 'assistant',
  },

  // Real provider identifiers
  IDENTIFIERS: {
    SELECTION_MESSAGE_ID: '[data-chatgpt-selection-message-id]',
    SEARCH_MESSAGE_IDS: '[data-chatgpt-search-message-ids]',
    SELECTION_CONVERSATION_ID: '[data-chatgpt-selection-conversation-id]',
    GENERIC_MESSAGE_ID: '[data-message-id]',
  },

  // Message content
  CONTENT: {
    ASSISTANT_MARKDOWN: '[data-markdown-text-style="assistant-message"]',
    MARKDOWN_PROSE: '.markdown, .prose, div[class*="markdown"]',
    CODE_BLOCKS: 'pre',
    CODE_ELEMENT: 'pre code',
    TABLES: 'table',
    IMAGES: 'img[src]',
    LINKS: 'a[href]',
    CITATIONS: 'a[href^="http"][target="_blank"], button[data-testid*="citation"]',
    ATTACHMENTS: '[data-testid*="file-attachment"], [data-testid*="attachment"], div[class*="attachment"]',
  },

  // Compose input box
  COMPOSER: {
    TEXTAREA: '#prompt-textarea',
    EDITABLE: 'div[contenteditable="true"]#prompt-textarea, #prompt-textarea',
    FILE_INPUT: 'input[type="file"]',
    SEND_BUTTON: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
  },

  // Metadata
  METADATA: {
    TITLE_TAG: 'title',
    CONVERSATION_TITLE_HEADER: 'header h1',
    SIDEBAR_ACTIVE_LINK: 'nav [class*="active"], nav a[aria-current="page"]',
    TITLE_HEADING: 'title',
  },
} as const;
