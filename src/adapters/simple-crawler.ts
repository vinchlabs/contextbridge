/**
 * Shared history crawler for providers that keep loaded turns mounted (Claude, Gemini).
 *
 * Walks the scroller upward one viewport at a time (never skipping unseen content), waits longer
 * at the top so lazy-loaded older history can arrive, and only reports 'top_reached' after
 * several stable cycles at scrollTop 0. Running out of attempts/time is reported explicitly so
 * the adapter can fail closed instead of exporting a silently truncated history.
 */

import { findScrollContainer, outermostElements } from '../utils/dom';
import { ExtractedMessageResult } from './chatgpt/extractor';
import { CaptureOptions, CaptureProgress } from './adapter';
import { CrawlResult } from './chatgpt/crawler';
import { CaptureIncompleteError, ConversationNotFoundError } from '../core/errors/errors';

export interface SimpleCrawlConfig {
  platformLabel: string;
  turnSelector: string;
  scrollContainerSelectors: string[];
  extract: (turnEl: Element, sequenceIndex: number) => ExtractedMessageResult | null;
}

interface CapturedEntry {
  item: ExtractedMessageResult;
  passIndex: number;
  localDomOrder: number;
}

export async function crawlSimpleConversation(
  doc: Document,
  options: CaptureOptions,
  onProgress: ((progress: CaptureProgress) => void) | undefined,
  signal: AbortSignal | undefined,
  config: SimpleCrawlConfig
): Promise<CrawlResult> {
  const scrollContainer = findScrollContainer(doc, [...config.scrollContainerSelectors]);
  const initialScrollTop = scrollContainer.scrollTop;
  const maxAttempts = options.maxScrollAttempts || 400;
  const scrollDelayMs = options.scrollDelayMs || 250;
  const topSettleMs = scrollDelayMs <= 50 ? scrollDelayMs * 2 : Math.max(900, Math.floor(scrollDelayMs * 3.5));
  const maxCrawlDurationMs = options.maxCrawlDurationMs || 180_000;
  const REQUIRED_STABLE_TOP_CYCLES = 3;
  const startedAt = Date.now();

  const capturedMap = new Map<string, CapturedEntry>();
  let scrollAttempts = 0;
  let stableTopCycles = 0;
  let terminationReason = 'unknown';

  function scanVisible(pass: number): number {
    // Nested selector matches (wrapper + inner element) would otherwise duplicate messages.
    const turns = outermostElements(Array.from(doc.querySelectorAll(config.turnSelector)));
    const occurrences = new Map<string, number>();
    let newlyFound = 0;

    for (let i = 0; i < turns.length; i++) {
      const extracted = config.extract(turns[i]!, i + 1);
      if (!extracted) continue;
      // Identical content-derived ids in one window (e.g. two "ok" replies) stay distinct.
      const baseId = extracted.message.id;
      const n = occurrences.get(baseId) ?? 0;
      occurrences.set(baseId, n + 1);
      if (n > 0) extracted.message.id = `${baseId}#${n}`;

      if (!capturedMap.has(extracted.message.id)) {
        capturedMap.set(extracted.message.id, { item: extracted, passIndex: pass, localDomOrder: i });
        newlyFound++;
      }
    }
    return newlyFound;
  }

  scanVisible(0);

  while (scrollAttempts < maxAttempts) {
    if (signal?.aborted) {
      terminationReason = 'aborted';
      break;
    }
    if (Date.now() - startedAt > maxCrawlDurationMs) {
      terminationReason = 'max_crawl_duration_reached';
      break;
    }

    const wasAtTop = scrollContainer.scrollTop <= 0;
    const heightBefore = scrollContainer.scrollHeight;
    const step = Math.max(400, Math.floor((scrollContainer.clientHeight || 1000) * 0.85));
    scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - step);
    scrollAttempts++;

    await new Promise((r) => setTimeout(r, wasAtTop ? topSettleMs : scrollDelayMs));

    const newlyDiscovered = scanVisible(scrollAttempts);
    const heightGrew = scrollContainer.scrollHeight > heightBefore + 50;
    if (newlyDiscovered > 0 || heightGrew) {
      stableTopCycles = 0;
    } else if (scrollContainer.scrollTop <= 0) {
      stableTopCycles++;
    }

    onProgress?.({
      phase: 'crawling',
      messagesFound: capturedMap.size,
      imagesFound: 0,
      filesFound: 0,
      currentOperation: `Crawling ${config.platformLabel} history (pass ${scrollAttempts}, messages: ${capturedMap.size})...`,
    });

    if (scrollContainer.scrollTop <= 0 && stableTopCycles >= REQUIRED_STABLE_TOP_CYCLES) {
      terminationReason = 'top_reached';
      break;
    }
  }

  if (terminationReason === 'unknown') {
    terminationReason = 'max_scroll_attempts_reached';
  }

  try {
    scrollContainer.scrollTop = initialScrollTop;
  } catch {
    // Ignore error restoring scroll
  }

  // Older history is discovered in later passes; inside one pass DOM order is chronological.
  const sortedList = Array.from(capturedMap.values())
    .sort((a, b) => (a.passIndex !== b.passIndex ? b.passIndex - a.passIndex : a.localDomOrder - b.localDomOrder))
    .map((e) => e.item);
  sortedList.forEach((item, i) => {
    item.message.sequence = i + 1;
  });

  return {
    results: sortedList,
    scrollAttempts,
    terminationReason,
    beginningReached: terminationReason === 'top_reached',
  };
}

/**
 * Fail-closed checks shared by the Claude and Gemini adapters: never deliver a cancelled,
 * truncated, or empty capture as a success.
 */
export function assertSimpleCrawlComplete(result: CrawlResult, signal: AbortSignal | undefined, platformLabel: string): void {
  if (signal?.aborted || result.terminationReason === 'aborted') {
    throw new CaptureIncompleteError('Capture cancelled by user.', { terminationReason: 'aborted' });
  }
  if (result.terminationReason !== 'top_reached') {
    throw new CaptureIncompleteError(
      `${platformLabel} history could not be fully loaded (${result.terminationReason}, ${result.results.length} messages seen). Scroll to the top of the conversation and try again.`,
      { terminationReason: result.terminationReason, scrollAttempts: result.scrollAttempts }
    );
  }
  if (result.results.length === 0) {
    throw new ConversationNotFoundError(platformLabel);
  }
}
