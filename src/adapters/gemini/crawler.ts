/**
 * History crawler for Gemini conversations (shared logic in ../simple-crawler).
 */

import { GEMINI_SELECTORS } from './selectors';
import { extractGeminiMessage } from './extractor';
import { CaptureOptions, CaptureProgress } from '../adapter';
import { CrawlResult } from '../chatgpt/crawler';
import { crawlSimpleConversation } from '../simple-crawler';

export async function crawlGeminiConversation(
  doc: Document = document,
  options: CaptureOptions = {},
  onProgress?: (progress: CaptureProgress) => void,
  signal?: AbortSignal
): Promise<CrawlResult> {
  return crawlSimpleConversation(doc, options, onProgress, signal, {
    platformLabel: 'Gemini',
    turnSelector: GEMINI_SELECTORS.TURNS.COMBINED_TURNS,
    scrollContainerSelectors: [...GEMINI_SELECTORS.SCROLL_CONTAINERS],
    extract: extractGeminiMessage,
  });
}
