/**
 * Virtual-scroll crawler for ChatGPT conversation history
 * Updated for ChatGPT's live column-reverse timeline scrolling model ([data-app-action-timeline-scroll])
 * where negative scrollTop moves toward older history, scrollHeight expands during lazy load,
 * and older boundaries are verified by multiple settle cycles.
 */

import { CHATGPT_SELECTORS } from './selectors';
import {
  extractChatGPTTurn,
  getTurnKeyFromElement,
  parseTurnNumber,
  ExtractedMessageResult,
} from './extractor';
import { CaptureOptions, CaptureProgress } from '../adapter';
import { CaptureIncompleteError } from '../../core/errors/errors';
import {
  CrawlerCandidateDiagnostic,
  CrawlerIterationLog,
  FileCardCandidateDiagnostic,
  FileCardResolutionDiagnostic,
  ResourceCardProbeDiagnostic,
} from '../../core/diagnostics/diagnostics';
import {
  CapturedFileBytes,
  FileCaptureInstaller,
  FileCaptureSession,
  openFileCaptureSession,
} from './file-card-resolver';
import { probeResourceCard, isElementConnected, MainWorldProbeInstaller } from './resource-card-probe';
import {
  findActiveThreadRoot,
  findActiveTimelineScroller,
  hasLayout,
  isRendered,
  queryActiveThread,
} from './active-thread';
import { DetectedUserFileCard } from './file-card-detector';

/**
 * Integration hooks supplied by the adapter. Kept out of CaptureOptions because they are
 * functions and CaptureOptions travels through extension messaging.
 */
export interface CrawlerHooks {
  /** Persists a diagnostics checkpoint immediately (awaited before/after the live probe). */
  onDiagnosticsCheckpoint?: (details: Record<string, unknown>, stage: string) => Promise<void> | void;
  /** Installs MAIN-world probe hooks through the extension (scripting.executeScript, world 'MAIN'). */
  installMainWorldProbe?: MainWorldProbeInstaller;
  /** Installs MAIN-world file capture hooks through the extension (same mechanism). */
  installMainWorldFileCapture?: FileCaptureInstaller;
}

export interface BaseCrawlResult {
  results: ExtractedMessageResult[];
  scrollAttempts: number;
  terminationReason: string;
}

export interface CrawlResult extends BaseCrawlResult {
  scrollContainerTag?: string;
  scrollContainerDescription?: string;
  scrollContainerAttributes?: Record<string, string>;
  initialScrollTop?: number;
  initialScrollHeight?: number;
  initialClientHeight?: number;
  finalScrollTop?: number;
  finalScrollHeight?: number;
  initialVisibleTurnCount?: number;
  newTurnsDiscovered?: number;
  oldestTurnKeySeen?: string;
  newestTurnKeySeen?: string;
  beginningReached?: boolean;
  crawlerCandidates?: CrawlerCandidateDiagnostic[];
  iterationLogs?: CrawlerIterationLog[];
  assistantOnlyTurns?: number;
  userUnitsWithNoCanonicalMessage?: number;
  attachmentSentinelUnits?: number;
  resolvedAttachmentOnlyUnits?: number;
  unresolvedAttachmentOnlyUnits?: number;
  fileCardsDetected?: number;
  fileCardsResolved?: number;
  fileCardsUnresolved?: number;
  fileCardCandidatesObserved?: FileCardCandidateDiagnostic[];
  resourceCardProbes?: ResourceCardProbeDiagnostic[];
  resourceCardProbeAttempts?: number;
  resourceCardProbeSuccesses?: number;
  resourceCardProbeFailures?: number;
  realFileBlobsCaptured?: number;
  /** true when the user disabled attachments, so unresolved file cards do not fail the capture */
  attachmentsExcludedByUser?: boolean;
  /** true when the user chose to copy anyway; unresolved file cards become "not included" markers */
  missingFilesAllowedByUser?: boolean;
  /** Real bytes captured for file cards (never part of diagnostics). */
  capturedFileBytes?: CapturedFileBytes[];
  fileCardResolutions?: FileCardResolutionDiagnostic[];
  fileCaptureMethod?: string;
  scrollContainerVisible?: boolean;
  finalAtOldestEdge?: boolean;
  unitTurnRange?: [number, number];
  unitTurnGaps?: string[];
}

interface CapturedEntry {
  item: ExtractedMessageResult;
  turnKey?: string;
  unitKey?: string;
  passIndex: number;
  localDomOrder: number;
  chronologicalRank: number;
}

export function describeCandidate(
  el: HTMLElement,
  index: number,
  doc: Document
): CrawlerCandidateDiagnostic {
  const tagName = el.tagName.toLowerCase();
  const id = el.id || '';
  const className =
    el.className && typeof el.className === 'string'
      ? el.className.trim().slice(0, 150)
      : '';

  const stableAttrs: Record<string, string> = {};
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i]!;
      if (
        (attr.name.startsWith('data-') ||
          attr.name.startsWith('aria-') ||
          attr.name === 'role') &&
        !attr.name.startsWith('data-react')
      ) {
        stableAttrs[attr.name] = attr.value.slice(0, 80);
      }
    }
  }

  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const style = win?.getComputedStyle ? win.getComputedStyle(el) : null;
  const computedOverflowY = style?.overflowY || '';
  const computedPosition = style?.position || '';

  const containsTurnKey = Boolean(el.querySelector(CHATGPT_SELECTORS.TURNS.PRIMARY));
  const containsVirtualizedContent = Boolean(
    el.querySelector('[data-virtualized-turn-content]')
  );

  return {
    index,
    tagName,
    id,
    stableAttributes: stableAttrs,
    className,
    scrollTop: el.scrollTop || 0,
    scrollHeight: el.scrollHeight || 0,
    clientHeight: el.clientHeight || 0,
    computedOverflowY,
    computedPosition,
    containsTurnKey,
    containsVirtualizedContent,
  };
}

/**
 * Finds all potential scroll container candidates for fallback probing.
 */
export function findScrollCandidates(doc: Document): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  function add(el: Element | null | undefined) {
    if (!el || !(el instanceof (doc.defaultView?.HTMLElement || HTMLElement))) return;
    const htmlEl = el as HTMLElement;
    if (!seen.has(htmlEl)) {
      seen.add(htmlEl);
      candidates.push(htmlEl);
    }
  }

  // 1. Primary timeline scroller of the ACTIVE thread (hidden app-shell pages are skipped)
  const timelineScroller = findActiveTimelineScroller(doc);
  if (timelineScroller) add(timelineScroller);
  const threadRoot: Document | HTMLElement = timelineScroller ?? doc;

  // 2. Ancestors of [data-virtualized-turn-content]
  const virtualEl = queryActiveThread(threadRoot, '[data-virtualized-turn-content]')[0];
  if (virtualEl) {
    let curr = virtualEl.parentElement;
    while (curr) {
      add(curr);
      curr = curr.parentElement;
    }
  }

  // 3. Ancestors of the first [data-turn-key]
  const firstTurn = queryActiveThread(threadRoot, CHATGPT_SELECTORS.TURNS.PRIMARY)[0];
  if (firstTurn) {
    let curr = firstTurn.parentElement;
    while (curr) {
      add(curr);
      curr = curr.parentElement;
    }
  }

  // 4. Known ChatGPT selectors
  for (const sel of CHATGPT_SELECTORS.SCROLL_CONTAINERS) {
    doc.querySelectorAll(sel).forEach((el) => add(el));
  }

  // 5. Standard scrolling elements
  if (doc.scrollingElement) add(doc.scrollingElement as HTMLElement);
  if (doc.documentElement) add(doc.documentElement);
  if (doc.body) add(doc.body);

  return candidates;
}

/**
 * Probes candidates using test scrolling and real DOM feedback (for fallback when primary scroller is absent).
 */
export function probeScrollCandidates(
  doc: Document,
  rawCandidates: HTMLElement[]
): { elements: HTMLElement[]; diagnostics: CrawlerCandidateDiagnostic[] } {
  const firstTurn = doc.querySelector(CHATGPT_SELECTORS.TURNS.PRIMARY);
  const initialRefTop = firstTurn ? firstTurn.getBoundingClientRect().top : undefined;

  const probed: { el: HTMLElement; diag: CrawlerCandidateDiagnostic; score: number }[] = [];

  for (let i = 0; i < rawCandidates.length; i++) {
    const el = rawCandidates[i]!;
    const diag = describeCandidate(el, i, doc);
    let score = 0;

    const isTimelineScroll =
      el.hasAttribute('data-app-action-timeline-scroll') ||
      (typeof el.matches === 'function' && el.matches('[data-app-action-timeline-scroll]'));

    if (isTimelineScroll) {
      score += 10000;
    }

    if (diag.scrollHeight > diag.clientHeight + 100) score += 200;
    if (Math.abs(diag.scrollTop) > 10) score += 100;
    if (diag.computedOverflowY === 'auto' || diag.computedOverflowY === 'scroll') score += 50;
    if (diag.containsVirtualizedContent) score += 50;
    if (diag.containsTurnKey) score += 50;

    const initialScrollTop = el.scrollTop;
    if (initialScrollTop !== 0 || diag.scrollHeight > diag.clientHeight) {
      const testDelta = initialScrollTop < 0 ? -150 : (initialScrollTop > 50 ? -150 : 50);
      const targetScroll = initialScrollTop + testDelta;

      try {
        el.scrollTop = targetScroll;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));

        const afterScrollTop = el.scrollTop;
        const afterRefTop = firstTurn ? firstTurn.getBoundingClientRect().top : undefined;

        let rectMoved = false;
        let rectDelta = 0;
        if (initialRefTop !== undefined && afterRefTop !== undefined) {
          rectDelta = Math.abs(afterRefTop - initialRefTop);
          if (rectDelta > 2) {
            rectMoved = true;
            score += 1000;
          }
        }

        const scrollDelta = Math.abs(afterScrollTop - initialScrollTop);
        if (scrollDelta > 5) {
          score += 500;
        }

        el.scrollTop = initialScrollTop;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));

        diag.probeScore = isTimelineScroll ? 9999 : score;
        diag.probeResult = isTimelineScroll
          ? 'selected as primary [data-app-action-timeline-scroll]'
          : `scrollDelta=${scrollDelta}px, rectMoved=${rectMoved ? rectDelta + 'px' : 'no'}, score=${score}`;
      } catch (err) {
        diag.probeScore = isTimelineScroll ? 9999 : score;
        diag.probeResult = `probeError=${String(err)}`;
      }
    } else {
      diag.probeScore = isTimelineScroll ? 9999 : score;
      diag.probeResult = isTimelineScroll
        ? 'selected as primary [data-app-action-timeline-scroll]'
        : `staticScore=${score}`;
    }

    probed.push({ el, diag, score: isTimelineScroll ? 9999 : score });
  }

  probed.sort((a, b) => b.score - a.score);
  probed.forEach((p, idx) => {
    p.diag.index = idx;
  });

  return {
    elements: probed.map((p) => p.el),
    diagnostics: probed.map((p) => p.diag),
  };
}

/**
 * Resolves the conversation scroller for ChatGPT.
 * Prioritizes [data-app-action-timeline-scroll] if present and controlling [data-turn-key].
 * Generic candidate probing is ONLY used as a compatibility fallback if this semantic element is absent.
 */
export function resolveConversationScroller(doc: Document): {
  element: HTMLElement;
  diagnostics: CrawlerCandidateDiagnostic[];
  isPrimary: boolean;
} {
  // 1. Primary: [data-app-action-timeline-scroll] of the thread actually on screen
  const timelineScroller = findActiveTimelineScroller(doc);
  const hasTurn = Boolean(
    timelineScroller?.querySelector(CHATGPT_SELECTORS.TURNS.PRIMARY) ||
    queryActiveThread(doc, CHATGPT_SELECTORS.TURNS.PRIMARY).length > 0
  );

  if (timelineScroller && hasTurn) {
    // Describe timelineScroller immediately without probing/mutating DOM
    const primaryDiag = describeCandidate(timelineScroller, 0, doc);
    primaryDiag.probeScore = 9999;
    primaryDiag.probeResult = 'selected as primary [data-app-action-timeline-scroll]';

    // Also describe other raw candidates statically for debug inspection (without test-scrolling)
    const rawCandidates = findScrollCandidates(doc);
    const otherDiags: CrawlerCandidateDiagnostic[] = [];
    let idx = 1;
    for (const el of rawCandidates) {
      if (el !== timelineScroller) {
        const d = describeCandidate(el, idx++, doc);
        d.probeScore = 100;
        d.probeResult = 'candidate inspected (primary timeline scroller active)';
        otherDiags.push(d);
      }
    }

    return {
      element: timelineScroller,
      diagnostics: [primaryDiag, ...otherDiags],
      isPrimary: true,
    };
  }

  // 2. Compatibility fallback: candidate probing
  const rawCandidates = findScrollCandidates(doc);
  const probed = probeScrollCandidates(doc, rawCandidates);
  const active = probed.elements[0] || (doc.scrollingElement as HTMLElement) || doc.body;

  return {
    element: active,
    diagnostics: probed.diagnostics,
    isPrimary: false,
  };
}

/**
 * Stitches successive mounted virtual windows of turn keys into a global ordered list.
 * Because the crawler traverses toward older history, newly discovered turns
 * appearing before a known overlap are prepended in document order.
 */
export function stitchWindowTurns(globalTurns: string[], windowTurns: string[]): string[] {
  if (globalTurns.length === 0) {
    return Array.from(new Set(windowTurns));
  }
  if (windowTurns.length === 0) {
    return [...globalTurns];
  }

  // De-duplicate windowTurns while preserving window order
  const uniqueWin: string[] = [];
  const seenWin = new Set<string>();
  for (const t of windowTurns) {
    if (!seenWin.has(t)) {
      seenWin.add(t);
      uniqueWin.push(t);
    }
  }

  // Find all matches between uniqueWin and globalTurns
  const matches: { winIdx: number; globalIdx: number }[] = [];
  for (let i = 0; i < uniqueWin.length; i++) {
    const gIdx = globalTurns.indexOf(uniqueWin[i]!);
    if (gIdx !== -1) {
      matches.push({ winIdx: i, globalIdx: gIdx });
    }
  }

  // If no match at all, since crawler scrolls backwards into older history, prepend
  if (matches.length === 0) {
    return [...uniqueWin, ...globalTurns];
  }

  // Ensure matches are sorted by globalIdx
  matches.sort((a, b) => a.globalIdx - b.globalIdx);

  const result: string[] = [];
  const resultSet = new Set<string>();

  const pushTurn = (t: string) => {
    if (!resultSet.has(t)) {
      resultSet.add(t);
      result.push(t);
    }
  };

  // 1. Prepend any turns appearing before the first matched turn in uniqueWin
  const firstMatch = matches[0]!;
  for (let i = 0; i < firstMatch.winIdx; i++) {
    pushTurn(uniqueWin[i]!);
  }

  // 2. Add existing global turns up to firstMatch.globalIdx
  for (let i = 0; i < firstMatch.globalIdx; i++) {
    pushTurn(globalTurns[i]!);
  }

  // 3. Process matches and intervals between matches
  for (let m = 0; m < matches.length; m++) {
    const curr = matches[m]!;
    pushTurn(uniqueWin[curr.winIdx]!);

    const next = matches[m + 1];
    if (next) {
      // Any turns in window between curr and next
      for (let i = curr.winIdx + 1; i < next.winIdx; i++) {
        pushTurn(uniqueWin[i]!);
      }
      // Any turns in global between curr and next
      for (let i = curr.globalIdx + 1; i < next.globalIdx; i++) {
        pushTurn(globalTurns[i]!);
      }
    } else {
      // Last match: any turns in window after curr
      for (let i = curr.winIdx + 1; i < uniqueWin.length; i++) {
        pushTurn(uniqueWin[i]!);
      }
      // Any turns in global after curr
      for (let i = curr.globalIdx + 1; i < globalTurns.length; i++) {
        pushTurn(globalTurns[i]!);
      }
    }
  }

  return result;
}

export async function crawlChatGPTConversation(
  doc: Document = document,
  options: CaptureOptions = {},
  onProgress?: (progress: CaptureProgress) => void,
  signal?: AbortSignal,
  hooks: CrawlerHooks = {}
): Promise<CrawlResult> {
  const crawlStartedAt = Date.now();
  const capturedMessagesById = new Map<string, ExtractedMessageResult>();
  const turnToMessageIds = new Map<string, string[]>();
  let globalTurnOrder: string[] = [];
  const iterationLogs: CrawlerIterationLog[] = [];

  let scrollAttempts = 0;
  let stableAttemptCount = 0;
  let boundaryVerificationCycles = 0;
  let terminationReason = 'unknown';
  const fileCardCandidatesObserved: FileCardCandidateDiagnostic[] = [];
  const seenFileCardSignatures = new Set<string>();

  // Live File Card Tracking & Probing
  const allDetectedFileCards: DetectedUserFileCard[] = [];
  const seenCardKeys = new Set<string>();
  let resourceCardProbeAttempts = 0;
  let resourceCardProbeSuccesses = 0;
  let resourceCardProbeFailures = 0;
  const resourceCardProbes: ResourceCardProbeDiagnostic[] = [];
  // Development diagnostic: probe exactly ONE live card per capture, only when bytes are wanted.
  const attachmentsExcluded = options.includeAttachments === false;
  // The probe did its job (it revealed files/download -> estuary); real capture below activates
  // every card anyway, so the probe is now opt-in.
  const probeEnabled = !attachmentsExcluded && options.resourceCardProbe === true;

  // Real byte capture for file cards, done while each card is mounted.
  const fileCaptureEnabled = !attachmentsExcluded && options.resolveFileCards !== false;
  // The user chose "copy anyway" after a capture named the files that could not be read.
  const missingFilesAllowed = !attachmentsExcluded && options.allowMissingFiles === true;
  const MAX_RESOLUTION_ATTEMPTS = 2;
  let captureSession: FileCaptureSession | null = null;
  let captureSessionOpened = false;
  let fileCaptureMethod: string | undefined;
  const capturedFileBytes = new Map<string, CapturedFileBytes>();
  const fileCardResolutions = new Map<string, FileCardResolutionDiagnostic>();
  const resolutionAttempts = new Map<string, number>();
  const cardKeyOf = (c: DetectedUserFileCard) => `${c.turnKey}:${c.filename}`;
  let probeNotInvokedReason: string | undefined;
  // Time spent inside the probe is not charged to the crawl wall-clock budget.
  let probeTimeExcludedMs = 0;
  // Filled once the scroller is resolved (used by live checkpoints).
  const live: {
    candidateDiagnostics?: CrawlerCandidateDiagnostic[];
    initialMetrics?: { initialScrollTop: number; initialScrollHeight: number; initialClientHeight: number };
  } = {};

  const maxAttempts = options.maxScrollAttempts || 1000;
  const scrollDelayMs = options.scrollDelayMs || 250;
  const boundarySettleMs =
    scrollDelayMs <= 50 ? scrollDelayMs * 2 : Math.max(900, Math.floor(scrollDelayMs * 3.5));

  let activeContainer: HTMLElement | null = null;

  // Every DOM read is scoped to the thread on screen (see active-thread.ts). React may replace
  // the scroller element, so the root is re-resolved when it gets detached.
  let threadRoot: Document | HTMLElement = findActiveThreadRoot(doc);
  function currentThreadRoot(): Document | HTMLElement {
    if (threadRoot !== doc && !(threadRoot as HTMLElement).isConnected) {
      threadRoot = findActiveThreadRoot(doc);
    }
    return threadRoot;
  }

  function getTurnElements(): Element[] {
    const root = currentThreadRoot();
    let elements = queryActiveThread(root, CHATGPT_SELECTORS.TURNS.PRIMARY);
    if (elements.length === 0) {
      elements = queryActiveThread(root, CHATGPT_SELECTORS.TURNS.FALLBACK_ARTICLE);
    }
    if (elements.length === 0) {
      elements = queryActiveThread(root, CHATGPT_SELECTORS.TURNS.FALLBACK_TESTID);
    }
    if (elements.length === 0) {
      elements = queryActiveThread(root, CHATGPT_SELECTORS.TURNS.FALLBACK_ROLE);
    }
    return elements;
  }

  function getTurnKeys(): string[] {
    return getTurnElements().map((el, i) => getTurnKeyFromElement(el, i));
  }

  function getUnitKeys(): string[] {
    const units = queryActiveThread(
      currentThreadRoot(),
      `${CHATGPT_SELECTORS.UNITS.PRIMARY}, ${CHATGPT_SELECTORS.UNITS.FALLBACK}`
    );
    return units
      .map(
        (u) =>
          u.getAttribute('data-content-search-unit-key') ||
          u.getAttribute('data-chatgpt-search-unit-key') ||
          ''
      )
      .filter(Boolean);
  }

  /** Serializable snapshot of the crawl so far (no DOM references). */
  function buildLiveDetails(stage: string): Record<string, unknown> {
    return {
      terminationReason: `in_progress:${stage}`,
      scrollAttempts,
      capturedMessagesCount: capturedMessagesById.size,
      beginningReached: false,
      fileCardsDetected: allDetectedFileCards.length,
      fileCardCandidatesObserved,
      resourceCardProbes: resourceCardProbes.map((p) => ({ ...p })),
      resourceCardProbeAttempts,
      resourceCardProbeSuccesses,
      resourceCardProbeFailures,
      fileCardsResolved: capturedFileBytes.size,
      fileCardsUnresolved: Math.max(0, allDetectedFileCards.length - capturedFileBytes.size),
      realFileBlobsCaptured: capturedFileBytes.size,
      fileCardResolutions: Array.from(fileCardResolutions.values()),
      fileCaptureMethod,
      attachmentsExcludedByUser: attachmentsExcluded,
      missingFilesAllowedByUser: missingFilesAllowed || undefined,
      ...(live.initialMetrics || {}),
      crawlerCandidates: live.candidateDiagnostics,
      iterationLogs,
    };
  }

  async function checkpoint(stage: string): Promise<void> {
    if (!hooks.onDiagnosticsCheckpoint) return;
    try {
      await hooks.onDiagnosticsCheckpoint(buildLiveDetails(stage), stage);
    } catch {
      // Persistence problems must never break the crawl.
    }
  }

  /**
   * One-shot live ResourceCardProbe (development diagnostic).
   * Runs while the detected card is STILL MOUNTED in the current virtual window, i.e. after the
   * window was scanned and before the crawler scrolls it away. Scrolling is paused because the
   * crawl loop awaits this call. The result (or failure) is persisted immediately.
   */
  async function maybeProbeFirstUnresolvedCard(
    windowCards: DetectedUserFileCard[],
    pass: number,
    windowTurnCount: number
  ): Promise<void> {
    if (resourceCardProbeAttempts > 0 || windowCards.length === 0) return;
    if (!probeEnabled) {
      probeNotInvokedReason = attachmentsExcluded ? 'attachments_excluded_by_user' : 'probe_disabled_by_option';
      return;
    }
    if (signal?.aborted) {
      probeNotInvokedReason = 'capture_aborted';
      return;
    }

    // FIRST unresolved card of this window whose exact button is still connected.
    // (No card has real bytes in this iteration, so every detected card is unresolved.)
    const cardIndex = windowCards.findIndex((c) => isElementConnected(c.buttonEl));
    if (cardIndex === -1) {
      probeNotInvokedReason = 'detected_card_not_connected_at_probe_time';
      return;
    }
    const card = windowCards[cardIndex]!;

    resourceCardProbeAttempts++;
    probeNotInvokedReason = undefined;
    const probeStartedAt = Date.now();
    const savedScrollTop = activeContainer ? activeContainer.scrollTop : undefined;
    const crawlContext: NonNullable<ResourceCardProbeDiagnostic['crawlContext']> = {
      scanPass: pass,
      scrollAttempts,
      containerScrollTop: savedScrollTop,
      containerScrollHeight: activeContainer?.scrollHeight,
      windowTurnCount,
      cardIndexInWindow: cardIndex,
      cardsDetectedSoFar: allDetectedFileCards.length,
      crawlElapsedMs: probeStartedAt - crawlStartedAt,
    };

    // Provisional entry persisted BEFORE activation: if the click unloads or navigates the page,
    // storage still proves the probe was invoked and which stage it reached.
    const provisional: ResourceCardProbeDiagnostic = {
      filename: card.filename,
      turnKey: card.turnKey,
      unitKey: card.unitKey,
      attempted: true,
      completed: false,
      elementWasConnected: true,
      result: 'probe_in_progress',
      outcome: 'probe_in_progress',
      stage: 'started',
      error: null,
      buttonAriaLabel: card.ariaLabel,
      spanTitle: card.spanTitle,
      crawlContext,
    };
    const slot = resourceCardProbes.push(provisional) - 1;
    onProgress?.({
      phase: 'crawling',
      messagesFound: capturedMessagesById.size,
      imagesFound: 0,
      filesFound: allDetectedFileCards.length,
      currentOperation: `Diagnostic probe: activating file card "${card.filename}"...`,
    });
    await checkpoint('probe_started');

    let result: ResourceCardProbeDiagnostic;
    try {
      result = await probeResourceCard(card, doc, {
        probeTimeoutMs: options.probeTimeoutMs,
        installMainWorld: hooks.installMainWorldProbe,
        onBeforeActivate: async () => {
          provisional.stage = 'activating';
          await checkpoint('probe_before_activation');
        },
      });
    } catch (err) {
      // probeResourceCard is designed not to throw; keep a record if it ever does.
      result = {
        ...provisional,
        result: 'probe_threw_exception',
        outcome: 'probe_error',
        error: err instanceof Error ? err.message : String(err),
        completed: false,
      };
    }
    result.crawlContext = crawlContext;
    resourceCardProbes[slot] = result;
    if (result.completed) {
      resourceCardProbeSuccesses++;
    } else {
      resourceCardProbeFailures++;
    }

    // Restore crawler state: timeline scroll position, then let virtualization settle.
    if (activeContainer && savedScrollTop !== undefined && activeContainer.scrollTop !== savedScrollTop) {
      activeContainer.scrollTop = savedScrollTop;
      try {
        activeContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch {
        // ignore
      }
    }
    if (activeContainer) {
      await waitForFrameAndDom(doc, activeContainer, Math.min(scrollDelayMs, 300));
    }
    probeTimeExcludedMs += Date.now() - probeStartedAt;
    await checkpoint('probe_finished');
  }

  /**
   * Captures the real bytes of every still-mounted, not yet captured card of the current window
   * (activate card -> ChatGPT's files/download -> download_url bytes). Runs before the window is
   * scrolled away; scrolling is paused and its time is not charged to the crawl budget.
   */
  async function resolveWindowCards(windowCards: DetectedUserFileCard[]): Promise<void> {
    if (!fileCaptureEnabled || windowCards.length === 0 || signal?.aborted) return;
    const pending = windowCards.filter(
      (c) =>
        !capturedFileBytes.has(cardKeyOf(c)) &&
        (resolutionAttempts.get(cardKeyOf(c)) ?? 0) < MAX_RESOLUTION_ATTEMPTS &&
        isElementConnected(c.buttonEl)
    );
    if (pending.length === 0) return;

    const started = Date.now();
    if (!captureSessionOpened) {
      captureSessionOpened = true;
      captureSession = await openFileCaptureSession(doc, {
        install: hooks.installMainWorldFileCapture,
        cardTimeoutMs: options.fileCaptureTimeoutMs,
        autoCleanupMs: (options.maxCrawlDurationMs || 300_000) + 15 * 60 * 1000,
      });
      fileCaptureMethod = captureSession.method;
    }
    const session = captureSession;
    if (!session || !session.ready) {
      for (const card of pending) {
        const key = cardKeyOf(card);
        resolutionAttempts.set(key, MAX_RESOLUTION_ATTEMPTS);
        fileCardResolutions.set(key, {
          filename: card.filename,
          turnKey: card.turnKey,
          attempted: false,
          status: 'unresolved',
          reason: `capture_hooks_unavailable${session?.installError ? `: ${session.installError}` : ''}`,
        });
      }
      return;
    }

    const savedScrollTop = activeContainer ? activeContainer.scrollTop : undefined;
    for (const card of pending) {
      if (signal?.aborted) break;
      if (!isElementConnected(card.buttonEl)) continue;
      const key = cardKeyOf(card);
      const attempt = (resolutionAttempts.get(key) ?? 0) + 1;
      resolutionAttempts.set(key, attempt);
      onProgress?.({
        phase: 'crawling',
        messagesFound: capturedMessagesById.size,
        imagesFound: 0,
        filesFound: capturedFileBytes.size,
        currentOperation: `Capturing file "${card.filename}" (${capturedFileBytes.size + 1} of ${allDetectedFileCards.length} found so far)...`,
      });
      const { diagnostic, bytes } = await session.resolveCard(card, attempt);
      fileCardResolutions.set(key, diagnostic);
      if (bytes) capturedFileBytes.set(key, bytes);
    }

    // Restore the crawler's scroll position and let virtualization settle.
    if (activeContainer && savedScrollTop !== undefined && activeContainer.scrollTop !== savedScrollTop) {
      activeContainer.scrollTop = savedScrollTop;
      try {
        activeContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch {
        // ignore
      }
    }
    if (activeContainer) {
      await waitForFrameAndDom(doc, activeContainer, Math.min(scrollDelayMs, 300));
    }
    probeTimeExcludedMs += Date.now() - started;
    await checkpoint('file_cards_captured');
  }

  async function scanVisible(
    pass: number,
    allowProbe: boolean
  ): Promise<{
    newlyFoundMessages: string[];
    newlyFoundTurns: string[];
    windowCards: DetectedUserFileCard[];
    windowTurnCount: number;
  }> {
    const turns = getTurnElements();
    const newlyFoundMessages: string[] = [];
    const newlyFoundTurns: string[] = [];
    // Cards detected in THIS window, in document order, with their live button elements.
    const windowCards: DetectedUserFileCard[] = [];
    const windowCardKeys = new Set<string>();

    const currentWindowTurns: string[] = [];
    for (let i = 0; i < turns.length; i++) {
      const tKey = getTurnKeyFromElement(turns[i]!, i);
      currentWindowTurns.push(tKey);
      if (!globalTurnOrder.includes(tKey)) {
        newlyFoundTurns.push(tKey);
      }
    }

    // Stitch current window turns into global turn order
    globalTurnOrder = stitchWindowTurns(globalTurnOrder, currentWindowTurns);

    for (let i = 0; i < turns.length; i++) {
      const turnEl = turns[i]!;
      const turnKey = getTurnKeyFromElement(turnEl, i);

      const extractedUnits = extractChatGPTTurn(turnEl, i + 1);

      if (!turnToMessageIds.has(turnKey)) {
        turnToMessageIds.set(turnKey, []);
      }
      const turnMsgIds = turnToMessageIds.get(turnKey)!;

      for (let u = 0; u < extractedUnits.length; u++) {
        const extracted = extractedUnits[u]!;
        const msgId = extracted.message.id;

        if (extracted.structuralCandidates && extracted.structuralCandidates.length > 0) {
          for (const cand of extracted.structuralCandidates) {
            const sig = `${cand.turnKey}|${cand.unitKey || ''}|${cand.relationToUserUnit}|${cand.tagName}|${cand.hrefKind || ''}|${cand.srcKind || ''}|${cand.textFilenameCandidate || ''}|${JSON.stringify(cand.stableAttributes)}`;
            if (!seenFileCardSignatures.has(sig)) {
              seenFileCardSignatures.add(sig);
              fileCardCandidatesObserved.push(cand);
            }
          }
        }

        if (extracted.detectedFileCards && extracted.detectedFileCards.length > 0) {
          for (const card of extracted.detectedFileCards) {
            if (!card.turnKey || card.turnKey === 'unknown') {
              card.turnKey = turnKey;
            }
            const cardKey = `${card.turnKey}:${card.filename}`;
            if (!windowCardKeys.has(cardKey)) {
              windowCardKeys.add(cardKey);
              windowCards.push(card);
            }
            if (!seenCardKeys.has(cardKey)) {
              seenCardKeys.add(cardKey);
              allDetectedFileCards.push(card);
            }
          }
        }

        if (!turnMsgIds.includes(msgId)) {
          turnMsgIds.push(msgId);
        }

        if (!capturedMessagesById.has(msgId)) {
          capturedMessagesById.set(msgId, extracted);
          newlyFoundMessages.push(msgId);
        } else {
          // If newly extracted message has more content parts or more mediaRefs, update it
          const existing = capturedMessagesById.get(msgId)!;
          if (
            extracted.message.content.length > existing.message.content.length ||
            extracted.mediaRefs.length > existing.mediaRefs.length
          ) {
            capturedMessagesById.set(msgId, extracted);
          }
        }
      }
    }

    // Live probe: the window was just scanned and has not been scrolled away yet.
    if (allowProbe) {
      await maybeProbeFirstUnresolvedCard(windowCards, pass, turns.length);
      await resolveWindowCards(windowCards);
    }

    return { newlyFoundMessages, newlyFoundTurns, windowCards, windowTurnCount: turns.length };
  }

  // 1. Initial measurement and scan BEFORE any scrolling or probing
  const initialTurnKeys = getTurnKeys();
  const initialVisibleTurnCount = initialTurnKeys.length;
  const initialScan = await scanVisible(0, false);

  // 2. Resolve scroller
  const { element: resolvedContainer, diagnostics: candidateDiagnostics, isPrimary } =
    resolveConversationScroller(doc);
  activeContainer = resolvedContainer;
  live.candidateDiagnostics = candidateDiagnostics;

  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const computedStyle = win?.getComputedStyle ? win.getComputedStyle(activeContainer) : null;
  const isColumnReverse =
    computedStyle?.flexDirection === 'column-reverse' ||
    activeContainer.style?.flexDirection === 'column-reverse' ||
    (activeContainer.getAttribute('style') || '').includes('column-reverse');

  const initialScrollTop = activeContainer.scrollTop;
  const initialScrollHeight = activeContainer.scrollHeight;
  const initialClientHeight = activeContainer.clientHeight;

  const report = () => {
    let imagesCount = 0;
    let filesCount = 0;
    for (const item of capturedMessagesById.values()) {
      for (const m of item.mediaRefs) {
        if (m.role === 'user-upload' && m.filename && !m.filename.endsWith('.png')) {
          filesCount++;
        } else {
          imagesCount++;
        }
      }
    }

    onProgress?.({
      phase: 'crawling',
      messagesFound: capturedMessagesById.size,
      imagesFound: imagesCount,
      filesFound: filesCount,
      currentOperation: `Crawling virtual history (pass ${scrollAttempts}, messages: ${capturedMessagesById.size})...`,
    });
  };

  report();

  live.initialMetrics = { initialScrollTop, initialScrollHeight, initialClientHeight };

  // One-shot live probe for a card already mounted in the initial window. Nothing has been
  // scrolled yet, and the initial metrics above were captured before the probe could act.
  await maybeProbeFirstUnresolvedCard(initialScan.windowCards, 0, initialScan.windowTurnCount);
  await resolveWindowCards(initialScan.windowCards);

  let oldestInitialTurnNumber: number | null = null;
  for (const k of initialTurnKeys) {
    const num = parseTurnNumber(k);
    if (num !== null) {
      if (oldestInitialTurnNumber === null || num < oldestInitialTurnNumber) {
        oldestInitialTurnNumber = num;
      }
    }
  }

  const startsAtBeginning = oldestInitialTurnNumber === 0 || oldestInitialTurnNumber === 1;
  const historyTraversalNeeded =
    !startsAtBeginning ||
    (isColumnReverse ? initialScrollTop < -50 : initialScrollTop > 50) ||
    initialScrollHeight > initialClientHeight + 300;

  // Wall-clock crawl time limit (primary termination control)
  // Stepwise traversal of long threads needs more time than edge jumping did.
  const maxCrawlDurationMs = options.maxCrawlDurationMs || 300_000;
  const crawlStartTime = Date.now();
  const probeTimeBeforeLoopMs = probeTimeExcludedMs;

  // Content-stable cycle tracking:
  // Only CONTENT PROGRESS (new turns, new messages, scrollHeight expansion >50px)
  // resets the content-stable counter. Physical scroll movement alone and unrelated
  // DOM mutations do NOT count as content progress.
  let contentStableCycles = 0;
  const REQUIRED_CONTENT_STABLE_CYCLES = 4;
  let lastCycleAtEdge = false;

  if (!historyTraversalNeeded && initialVisibleTurnCount <= 4 && initialScrollTop === 0) {
    terminationReason = 'already_at_start';
  } else {
    // Start from the newest edge so turns below the user's current position are covered too
    // (the traversal below only moves toward older history).
    const newestTarget = isColumnReverse
      ? 0
      : Math.max(0, activeContainer.scrollHeight - activeContainer.clientHeight);
    if (Math.abs(activeContainer.scrollTop - newestTarget) > 2) {
      activeContainer.scrollTop = newestTarget;
      try {
        activeContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch {
        // ignore
      }
      await waitForFrameAndDom(doc, activeContainer, scrollDelayMs);
      await scanVisible(0, true);
    }

    while (scrollAttempts < maxAttempts) {
      if (signal?.aborted) {
        terminationReason = 'aborted';
        break;
      }

      // Wall-clock timeout check (time spent in the diagnostic probe is not charged)
      if (Date.now() - crawlStartTime - (probeTimeExcludedMs - probeTimeBeforeLoopMs) > maxCrawlDurationMs) {
        terminationReason = 'max_crawl_duration_reached';
        break;
      }

      const turnKeysBefore = getTurnKeys();
      const unitKeysBefore = getUnitKeys();
      const scrollTopBefore = activeContainer.scrollTop;
      const scrollHeightBefore = activeContainer.scrollHeight;
      const clientHeight = activeContainer.clientHeight;

      // ── Stepwise traversal toward older history ────────────────────
      // In column-reverse: scrollTop=0 is newest, -(scrollHeight-clientHeight) is oldest.
      // In normal: scrollTop=0 is oldest.
      // ChatGPT virtualizes the thread and knows its full height up front (live run: 21 218 px
      // with only 3 turns mounted), so jumping straight to the oldest edge never mounts the turns
      // in between. Move ~0.8 viewport per cycle (consecutive windows overlap, which also anchors
      // stitching) and re-measure every cycle because scrollHeight grows as older chunks load.
      const step = Math.max(200, Math.floor((clientHeight || 600) * 0.8));
      let requestedScrollTop: number;

      if (isColumnReverse) {
        const physicalOldest = -(scrollHeightBefore - clientHeight);
        // Never request beyond the physical boundary (small margin to ensure contact)
        requestedScrollTop = Math.max(physicalOldest - 100, scrollTopBefore - step);
      } else {
        requestedScrollTop = Math.max(0, scrollTopBefore - step);
      }

      // Extended settle delay only while sitting at the oldest edge (lazy-loading window)
      const effectiveDelay = lastCycleAtEdge ? boundarySettleMs : scrollDelayMs;

      // Direct assignment
      const stepStartedAt = Date.now();
      activeContainer.scrollTop = requestedScrollTop;
      try {
        activeContainer.dispatchEvent(new Event('scroll', { bubbles: true, cancelable: true }));
      } catch {}

      scrollAttempts++;

      // Wait for frame and DOM settling (longer near boundary to allow lazy-loading)
      const { mutationCount } = await waitForFrameAndDom(doc, activeContainer, effectiveDelay);
      // An unrelated mutation can end the wait after ~40 ms; give the virtualizer a few frames
      // to mount the new window anyway.
      const minStepMs = Math.min(effectiveDelay, 150);
      const stepElapsed = Date.now() - stepStartedAt;
      if (stepElapsed < minStepMs) {
        await new Promise((r) => setTimeout(r, minStepMs - stepElapsed));
      }

      const scrollTopAfter = activeContainer.scrollTop;
      const scrollHeightAfter = activeContainer.scrollHeight;
      const turnKeysAfter = getTurnKeys();
      const unitKeysAfter = getUnitKeys();

      const { newlyFoundMessages, newlyFoundTurns } = await scanVisible(scrollAttempts, true);
      report();

      // ── Content progress detection ─────────────────────────────────
      // ONLY these count as content progress that resets the stability counter:
      // 1. New turn UUIDs appeared (not seen in any prior window)
      // 2. New message IDs appeared (not seen in any prior extraction)
      // 3. scrollHeight expanded meaningfully (>50px indicates new history chunk loaded)
      //
      // The following are NOT content progress:
      // - scrollTop changed (physical movement through already-loaded content)
      // - DOM mutations observed (unrelated UI activity — repaints, animations, tooltips)
      const turnsChanged = newlyFoundTurns.length > 0;
      const messagesDiscovered = newlyFoundMessages.length > 0;
      const scrollHeightExpanded = scrollHeightAfter - scrollHeightBefore > 50;

      const contentProgress = turnsChanged || messagesDiscovered || scrollHeightExpanded;

      // Oldest edge: geometrically at the limit, or the browser refused to move any further.
      const geometricEdge = isColumnReverse
        ? scrollTopAfter <= -(scrollHeightAfter - clientHeight) + 5
        : scrollTopAfter <= 5;
      const refusedToMove = Math.abs(scrollTopAfter - scrollTopBefore) < 2;
      const atOldestEdge = geometricEdge || refusedToMove;
      lastCycleAtEdge = atOldestEdge;

      if (contentProgress || !atOldestEdge) {
        // Stability only counts while parked at the oldest edge: in the middle of a long thread a
        // step can reveal nothing new (one huge turn spanning several viewports).
        contentStableCycles = 0;
        // Also reset legacy counters for backward-compatible diagnostics
        stableAttemptCount = 0;
        boundaryVerificationCycles = 0;
      } else {
        contentStableCycles++;
        stableAttemptCount++;
        boundaryVerificationCycles++;
      }

      iterationLogs.push({
        iteration: scrollAttempts,
        scrollTopBefore,
        requestedScrollTop,
        scrollTopAfter,
        scrollHeightBefore,
        scrollHeightAfter,
        visibleTurnKeysBefore: turnKeysBefore,
        visibleTurnKeysAfter: turnKeysAfter,
        newTurnKeys: newlyFoundTurns,
        newMessageIds: newlyFoundMessages,
        mutationCount,
        stableAttemptCount: contentStableCycles,
        clientHeight,
        visibleUnitKeysBefore: unitKeysBefore,
        visibleUnitKeysAfter: unitKeysAfter,
        newMessagesDiscovered: newlyFoundMessages.length,
      });

      // ── Boundary acceptance ────────────────────────────────────────
      // Accept "oldest history boundary reached" only after N consecutive cycles
      // where NO content progress occurred. This means:
      // - No new turn UUIDs
      // - No new message IDs
      // - scrollHeight did not expand (no new history chunk loaded)
      // Unrelated DOM mutations (8, 48, 10, 36, 14, 40 per cycle in real ChatGPT)
      // do NOT prevent boundary acceptance.
      if (contentStableCycles >= REQUIRED_CONTENT_STABLE_CYCLES) {
        terminationReason = isColumnReverse
          ? 'oldest_history_boundary_reached'
          : 'conversation_start_reached';
        break;
      }
    }

    if (scrollAttempts >= maxAttempts && terminationReason === 'unknown') {
      terminationReason = 'max_scroll_attempts_reached';
    }
  }

  // Late pass: a card whose click only brought ChatGPT's cached metadata (file id known, no
  // download request) is fetched once more without clicking. By now ChatGPT's own files/download
  // request has usually been seen for another card, so the replay copies it exactly.
  // (captureSession is assigned inside resolveWindowCards, which flow analysis cannot see.)
  const lateSession = captureSession as FileCaptureSession | null;
  if (lateSession?.ready && !signal?.aborted) {
    let retried = 0;
    for (const card of allDetectedFileCards) {
      if (signal?.aborted) break;
      const key = cardKeyOf(card);
      const previous = fileCardResolutions.get(key);
      if (capturedFileBytes.has(key) || !previous?.fileId) continue;
      onProgress?.({
        phase: 'crawling',
        messagesFound: capturedMessagesById.size,
        imagesFound: 0,
        filesFound: capturedFileBytes.size,
        currentOperation: `Retrying file "${card.filename}"...`,
      });
      const attempt = Math.max(resolutionAttempts.get(key) ?? 0, previous.attemptNumber ?? 0) + 1;
      resolutionAttempts.set(key, attempt);
      const { diagnostic, bytes } = await lateSession.resolveByFileId(card, previous.fileId, attempt);
      // Keep what the click itself showed next to the late result.
      fileCardResolutions.set(key, {
        ...diagnostic,
        eventsSeen: previous.eventsSeen,
        panelsOpened: previous.panelsOpened,
        panelsStillOpen: previous.panelsStillOpen,
        durationMs: (previous.durationMs ?? 0) + (diagnostic.durationMs ?? 0),
      });
      if (bytes) capturedFileBytes.set(key, bytes);
      retried++;
    }
    if (retried > 0) await checkpoint('file_cards_late_pass');
  }

  // Traversal is over: remove the MAIN-world capture hooks.
  lateSession?.close();

  // Record final reached state before restoring scroll position
  const finalScrollTop = activeContainer.scrollTop;
  const finalScrollHeight = activeContainer.scrollHeight;
  const newTurnsDiscovered = Math.max(0, globalTurnOrder.length - initialVisibleTurnCount);

  // Restore scroll position
  try {
    activeContainer.scrollTop = initialScrollTop;
    activeContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
  } catch {}

  // Determine turn keys range seen
  const allTurnKeys = [...globalTurnOrder];
  let oldestTurnKeySeen = allTurnKeys[0] || 'none';
  let newestTurnKeySeen = allTurnKeys[allTurnKeys.length - 1] || 'none';

  let minTurnNum = Infinity;
  let maxTurnNum = -Infinity;

  for (const k of allTurnKeys) {
    const num = parseTurnNumber(k);
    if (num !== null) {
      if (num < minTurnNum) {
        minTurnNum = num;
        oldestTurnKeySeen = k;
      }
      if (num > maxTurnNum) {
        maxTurnNum = num;
        newestTurnKeySeen = k;
      }
    }
  }

  const oldestMatch = oldestTurnKeySeen.match(/((?:fallback-)?turn-\d+)/i);
  if (oldestMatch && oldestMatch[1]) {
    oldestTurnKeySeen = oldestMatch[1];
  }
  const newestMatch = newestTurnKeySeen.match(/((?:fallback-)?turn-\d+)/i);
  if (newestMatch && newestMatch[1]) {
    newestTurnKeySeen = newestMatch[1];
  }

  // A hidden scroller (0x0, e.g. an inactive app-shell page) "reaches" its boundary instantly
  // without loading anything; with a real layout engine that is never proof of completeness.
  const layoutAvailable = hasLayout(doc);
  const containerVisible = !layoutAvailable || isRendered(activeContainer);
  if (!containerVisible && terminationReason !== 'aborted') {
    terminationReason = 'scroll_container_not_visible';
  }
  const finalClientHeight = activeContainer.clientHeight;
  const scrollable = finalScrollHeight > finalClientHeight + 5;
  const finalAtOldestEdge = !layoutAvailable || !scrollable
    ? true
    : isColumnReverse
      ? finalScrollTop <= -(finalScrollHeight - finalClientHeight) + 150
      : finalScrollTop <= 150;

  let beginningReached = false;
  if (!historyTraversalNeeded) {
    beginningReached = containerVisible;
  } else {
    const boundaryReached =
      terminationReason === 'oldest_history_boundary_reached' ||
      terminationReason === 'conversation_start_reached';
    const reachedTurnZeroOrOne = minTurnNum === 0 || minTurnNum === 1;

    if (
      boundaryReached &&
      containerVisible &&
      finalAtOldestEdge &&
      (newTurnsDiscovered > 0 || reachedTurnZeroOrOne || minTurnNum === Infinity)
    ) {
      beginningReached = true;
    }
  }

  // Informational: ChatGPT unit keys carry "fallback-turn-N". Numbering has been seen both global
  // (live: 31..33 for the newest window) and per-window, so gaps are reported, not enforced.
  const unitTurnNumbers = new Set<number>();
  for (const item of capturedMessagesById.values()) {
    const unitKey = item.message.metadata?.unitKey;
    const m = typeof unitKey === 'string' ? unitKey.match(/fallback-turn-(\d+)/) : null;
    if (m?.[1]) unitTurnNumbers.add(parseInt(m[1], 10));
  }
  const sortedUnitTurns = Array.from(unitTurnNumbers).sort((a, b) => a - b);
  const unitTurnGaps: string[] = [];
  if (sortedUnitTurns.length > 0) {
    let expected = 0;
    for (const n of sortedUnitTurns) {
      if (n > expected) unitTurnGaps.push(n - 1 === expected ? `${expected}` : `${expected}-${n - 1}`);
      expected = n + 1;
    }
  }

  const primaryCandidateDiag = candidateDiagnostics[0];
  const containerDescription = primaryCandidateDiag
    ? `<${primaryCandidateDiag.tagName}#${primaryCandidateDiag.id}.${primaryCandidateDiag.className}> (flexDirection: ${computedStyle?.flexDirection || 'normal'})`
    : 'unknown';

  let attachmentSentinelUnits = 0;
  let resolvedAttachmentOnlyUnits = 0;
  let unresolvedAttachmentOnlyUnits = 0;

  for (const item of capturedMessagesById.values()) {
    if (item.isAttachmentSentinel || item.message.metadata?.isAttachmentSentinel) {
      attachmentSentinelUnits++;
      if (item.isUnresolvedAttachment || item.message.content.length === 0) {
        unresolvedAttachmentOnlyUnits++;
      } else {
        resolvedAttachmentOnlyUnits++;
      }
    }
  }

  // Also collect any additional cards from captured messages not picked up during scans
  for (const item of capturedMessagesById.values()) {
    if (item.detectedFileCards) {
      for (const card of item.detectedFileCards) {
        const cardKey = `${card.turnKey}:${card.filename}`;
        if (!seenCardKeys.has(cardKey)) {
          seenCardKeys.add(cardKey);
          allDetectedFileCards.push(card);
        }
      }
    }
  }

  const fileCardsDetected = allDetectedFileCards.length;
  // Resolved = real bytes were received for that exact card (never inferred from a filename).
  const fileCardsResolved = allDetectedFileCards.filter((c) => capturedFileBytes.has(cardKeyOf(c))).length;
  const fileCardsUnresolved = Math.max(0, fileCardsDetected - fileCardsResolved);
  if (fileCaptureEnabled) {
    for (const card of allDetectedFileCards) {
      const key = cardKeyOf(card);
      if (!fileCardResolutions.has(key)) {
        fileCardResolutions.set(key, {
          filename: card.filename,
          turnKey: card.turnKey,
          attempted: false,
          status: 'unresolved',
          reason: 'card_never_mounted_during_capture',
        });
      }
    }
  }
  const fileCardResolutionList = Array.from(fileCardResolutions.values());
  const unitTurnRange: [number, number] | undefined =
    sortedUnitTurns.length > 0 ? [sortedUnitTurns[0]!, sortedUnitTurns[sortedUnitTurns.length - 1]!] : undefined;

  // PROBE NEVER CALLED must stay distinguishable from PROBE CALLED BUT OBSERVED NOTHING:
  // record an explicit attempted:false entry, without touching the attempt counters.
  if (probeEnabled && resourceCardProbeAttempts === 0 && allDetectedFileCards.length > 0) {
    const firstCard = allDetectedFileCards[0]!;
    resourceCardProbes.push({
      filename: firstCard.filename,
      turnKey: firstCard.turnKey,
      unitKey: firstCard.unitKey,
      attempted: false,
      completed: false,
      notInvokedReason:
        probeNotInvokedReason ??
        (probeEnabled ? 'no_mounted_card_when_detected' : attachmentsExcluded ? 'attachments_excluded_by_user' : 'probe_disabled_by_option'),
      elementWasConnected: isElementConnected(firstCard.buttonEl),
      result: 'probe_not_invoked',
      outcome: 'probe_not_invoked',
      error: null,
      buttonAriaLabel: firstCard.ariaLabel,
      spanTitle: firstCard.spanTitle,
    });
  }

  // Shared diagnostic payload for every fail-closed exit and the success result.
  const baseDetails = {
    scrollAttempts,
    scrollTop: finalScrollTop,
    capturedMessagesCount: capturedMessagesById.size,
    initialVisibleTurnCount,
    newTurnsDiscovered,
    oldestTurnKeySeen,
    newestTurnKeySeen,
    beginningReached,
    attachmentSentinelUnits,
    resolvedAttachmentOnlyUnits,
    unresolvedAttachmentOnlyUnits,
    fileCardsDetected,
    fileCardsResolved,
    fileCardsUnresolved,
    fileCardCandidatesObserved,
    resourceCardProbes,
    resourceCardProbeAttempts,
    resourceCardProbeSuccesses,
    resourceCardProbeFailures,
    realFileBlobsCaptured: fileCardsResolved,
    fileCardResolutions: fileCardResolutionList,
    fileCaptureMethod,
    attachmentsExcludedByUser: attachmentsExcluded,
    missingFilesAllowedByUser: missingFilesAllowed || undefined,
    scrollContainerVisible: containerVisible,
    finalAtOldestEdge,
    unitTurnRange,
    unitTurnGaps,
    initialScrollTop,
    initialScrollHeight,
    initialClientHeight,
    finalScrollTop,
    finalScrollHeight,
    scrollContainerDescription: containerDescription,
    crawlerCandidates: candidateDiagnostics,
    iterationLogs,
  };

  // FAIL CLOSED: If beginning is not proven, throw CaptureIncompleteError
  if (!beginningReached && terminationReason !== 'aborted') {
    throw new CaptureIncompleteError(
      `ChatGPT crawler failed to traverse virtual history (reason: ${terminationReason}, scrollTop: ${finalScrollTop}, captured: ${capturedMessagesById.size} messages across ${initialVisibleTurnCount} initial turns, new turns discovered: ${newTurnsDiscovered}). Full history was not reached.`,
      { ...baseDetails, terminationReason, beginningReached: false }
    );
  }

  // Assemble final messages strictly in globalTurnOrder, preserving intra-turn document order
  const sortedList: ExtractedMessageResult[] = [];
  const addedMsgIds = new Set<string>();

  for (const turnKey of globalTurnOrder) {
    const msgIds = turnToMessageIds.get(turnKey) || [];
    const turnMessages = msgIds
      .map((id) => capturedMessagesById.get(id))
      .filter((item): item is ExtractedMessageResult => Boolean(item));

    // Sort strictly by intra-turn slot order:
    // Slot 0 (user) comes before Slot 2 (assistant)
    turnMessages.sort((a, b) => {
      const slotA = a.intraTurnIndex ?? (a.message.role === 'user' ? 0 : 2);
      const slotB = b.intraTurnIndex ?? (b.message.role === 'user' ? 0 : 2);
      if (slotA !== slotB) return slotA - slotB;
      if (a.message.role === 'user' && b.message.role !== 'user') return -1;
      if (a.message.role !== 'user' && b.message.role === 'user') return 1;
      return 0;
    });

    for (const item of turnMessages) {
      if (!addedMsgIds.has(item.message.id)) {
        addedMsgIds.add(item.message.id);
        sortedList.push(item);
      }
    }
  }

  // Fallback for any messages not linked to globalTurnOrder
  for (const [id, item] of capturedMessagesById.entries()) {
    if (!addedMsgIds.has(id)) {
      addedMsgIds.add(id);
      sortedList.push(item);
    }
  }

  // Re-number sequence sequentially 1..N
  sortedList.forEach((item, i) => {
    item.message.sequence = i + 1;
  });

  // ── Turn Completeness Validation ───────────────────────────────
  // Inspect every turn: check for assistant-only turns and unextracted user units in DOM
  let assistantOnlyTurns = 0;
  for (const turnKey of globalTurnOrder) {
    const msgIds = turnToMessageIds.get(turnKey) || [];
    const msgs = msgIds
      .map((id) => capturedMessagesById.get(id))
      .filter((item): item is ExtractedMessageResult => Boolean(item));
    const hasAsst = msgs.some((m) => m.message.role === 'assistant');
    const hasUser = msgs.some((m) => m.message.role === 'user');
    if (hasAsst && !hasUser) {
      assistantOnlyTurns++;
    }
  }

  // Count user units in the current DOM with no canonical message
  let userUnitsWithNoCanonicalMessage = 0;
  const currentDomUserUnits = queryActiveThread(currentThreadRoot(), CHATGPT_SELECTORS.UNITS.USER_FILTER);
  for (const uEl of currentDomUserUnits) {
    const uKey =
      uEl.getAttribute('data-content-search-unit-key') ||
      uEl.getAttribute('data-chatgpt-search-unit-key');
    const matched = Array.from(capturedMessagesById.values()).some((m) => {
      return (
        m.message.metadata?.unitKey === uKey ||
        (uKey ? m.message.id.includes(uKey) : false)
      );
    });
    if (!matched) {
      userUnitsWithNoCanonicalMessage++;
    }
  }

  // Fail-closed validation: if a user unit exists in the mounted DOM but produced no canonical message,
  // this is an extraction bug and must fail closed rather than silently exporting
  if (userUnitsWithNoCanonicalMessage > 0 && terminationReason !== 'aborted') {
    throw new CaptureIncompleteError(
      `ChatGPT extraction incomplete: ${userUnitsWithNoCanonicalMessage} user unit(s) in DOM failed to produce canonical user messages.`,
      {
        ...baseDetails,
        terminationReason: 'user_units_missing_message',
        assistantOnlyTurns,
        userUnitsWithNoCanonicalMessage,
      }
    );
  }

  // Fail-closed validation: Every detected real file card must end in exactly one of:
  // RESOLVED -> canonical type:"file" + real BLOB
  // or UNRESOLVED -> capture must fail closed.
  // Successful export requires fileCardsUnresolved === 0, regardless of whether the user message also contains text/images.
  // Exceptions, both explicit user choices so nothing goes missing silently: attachments were
  // turned off, or the user chose to copy anyway after being told which files failed. The
  // adapter replaces those parts with explicit "not included" markers.
  if (
    !attachmentsExcluded &&
    !missingFilesAllowed &&
    (fileCardsUnresolved > 0 || unresolvedAttachmentOnlyUnits > 0) &&
    terminationReason !== 'aborted'
  ) {
    const errorCount = fileCardsUnresolved > 0 ? fileCardsUnresolved : unresolvedAttachmentOnlyUnits;
    const missingFiles = allDetectedFileCards
      .filter((c) => !capturedFileBytes.has(cardKeyOf(c)))
      .map((c) => c.filename);
    const named = missingFiles.slice(0, 5).map((name) => `"${name}"`).join(', ');
    throw new CaptureIncompleteError(
      `ChatGPT extraction incomplete: ${errorCount} user file card(s) could not be resolved to real file bytes${named ? `: ${named}` : ''}.`,
      {
        ...baseDetails,
        terminationReason: 'unresolved_user_attachment',
        assistantOnlyTurns,
        userUnitsWithNoCanonicalMessage,
        missingFiles,
      }
    );
  }

  return {
    results: sortedList,
    scrollAttempts,
    terminationReason,
    scrollContainerTag: primaryCandidateDiag?.tagName,
    scrollContainerDescription: containerDescription,
    scrollContainerAttributes: primaryCandidateDiag?.stableAttributes,
    initialScrollTop,
    initialScrollHeight,
    initialClientHeight,
    finalScrollTop,
    finalScrollHeight,
    initialVisibleTurnCount,
    newTurnsDiscovered,
    oldestTurnKeySeen,
    newestTurnKeySeen,
    beginningReached,
    assistantOnlyTurns,
    userUnitsWithNoCanonicalMessage,
    attachmentSentinelUnits,
    resolvedAttachmentOnlyUnits,
    unresolvedAttachmentOnlyUnits,
    fileCardsDetected,
    fileCardsResolved,
    fileCardsUnresolved,
    fileCardCandidatesObserved,
    resourceCardProbes,
    resourceCardProbeAttempts,
    resourceCardProbeSuccesses,
    resourceCardProbeFailures,
    realFileBlobsCaptured: fileCardsResolved,
    attachmentsExcludedByUser: attachmentsExcluded,
    missingFilesAllowedByUser: missingFilesAllowed || undefined,
    capturedFileBytes: Array.from(capturedFileBytes.values()),
    fileCardResolutions: fileCardResolutionList,
    fileCaptureMethod,
    scrollContainerVisible: containerVisible,
    finalAtOldestEdge,
    unitTurnRange,
    unitTurnGaps,
    crawlerCandidates: candidateDiagnostics,
    iterationLogs,
  };
}

function waitForFrameAndDom(
  doc: Document,
  container: HTMLElement,
  timeoutMs: number
): Promise<{ mutationCount: number }> {
  return new Promise((resolve) => {
    let resolved = false;
    let mutationCount = 0;

    const finish = () => {
      if (!resolved) {
        resolved = true;
        observer?.disconnect();
        resolve({ mutationCount });
      }
    };

    const timer = setTimeout(finish, timeoutMs);

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      try {
        observer = new MutationObserver((mutations) => {
          mutationCount += mutations.length;
          clearTimeout(timer);
          setTimeout(finish, 40);
        });
        observer.observe(container, { childList: true, subtree: true, attributes: false });
      } catch {}
    }

    const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (win && typeof win.requestAnimationFrame === 'function') {
      try {
        win.requestAnimationFrame(() => {
          // Frame rendered
        });
      } catch {}
    }
  });
}
