/**
 * History crawler for Claude conversations (shared logic in ../simple-crawler).
 */

import { CLAUDE_SELECTORS } from './selectors';
import { extractClaudeMessage } from './extractor';
import { CaptureOptions, CaptureProgress } from '../adapter';
import { CrawlResult } from '../chatgpt/crawler';
import { crawlSimpleConversation } from '../simple-crawler';

export async function crawlClaudeConversation(
  doc: Document = document,
  options: CaptureOptions = {},
  onProgress?: (progress: CaptureProgress) => void,
  signal?: AbortSignal
): Promise<CrawlResult> {
  return crawlSimpleConversation(doc, options, onProgress, signal, {
    platformLabel: 'Claude',
    turnSelector: CLAUDE_SELECTORS.TURNS.COMBINED,
    scrollContainerSelectors: [...CLAUDE_SELECTORS.SCROLL_CONTAINERS],
    extract: extractClaudeMessage,
  });
}
