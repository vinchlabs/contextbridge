/**
 * Sanitized diagnostic reporting for ContextBridge
 * Does not include private conversation text.
 */

export interface SelectorDiagnostic {
  strategyName: string;
  found: boolean;
  matchCount: number;
}

export interface CrawlerCandidateDiagnostic {
  index: number;
  tagName: string;
  id: string;
  stableAttributes: Record<string, string>;
  className: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  computedOverflowY: string;
  computedPosition: string;
  containsTurnKey: boolean;
  containsVirtualizedContent: boolean;
  probeScore?: number;
  probeResult?: string;
}

export interface CrawlerIterationLog {
  iteration: number;
  scrollTopBefore: number;
  requestedScrollTop: number;
  scrollTopAfter: number;
  scrollHeightBefore: number;
  scrollHeightAfter: number;
  visibleTurnKeysBefore: string[];
  visibleTurnKeysAfter: string[];
  newTurnKeys: string[];
  newMessageIds: string[];
  mutationCount: number;
  stableAttemptCount: number;
  // Optional / backward-compatible properties
  selectedCandidateIndex?: number;
  scrollTopImmediatelyAfter?: number;
  scrollTopAfterSettling?: number;
  clientHeight?: number;
  visibleUnitKeysBefore?: string[];
  visibleUnitKeysAfter?: string[];
  newMessagesDiscovered?: number;
  mutationCountObserved?: number;
  stallCount?: number;
  candidateSwitchReason?: string;
}

export interface AdapterDiagnostics {
  timestamp: string;
  adapterId: string;
  adapterVersion: string;
  sanitizedUrl: string;
  selectorStrategiesEvaluated: SelectorDiagnostic[];
  detectedMessagesCount: number;
  unresolvedElementsCount: number;
  crawlerScrollAttempts: number;
  crawlerTerminationReason: string;
  attachmentsDetected: number;
  attachmentBytesTotal: number;
  browserEnvironment: {
    userAgent: string;
    compressionStreamSupported: boolean;
    cryptoSubtleSupported: boolean;
  };

  // Live crawler state & verification fields
  chatgptTurnCount?: number;
  chatgptUnitCount?: number;
  messageIdsFound?: number;
  conversationIdFound?: boolean;
  crawlerIterations?: number;
  capturedMessageCount?: number;
  initialVisibleTurnCount?: number;
  oldestTurnKeySeen?: string;
  newestTurnKeySeen?: string;
  scrollContainerDescription?: string;
  initialScrollTop?: number;
  initialScrollHeight?: number;
  initialClientHeight?: number;
  finalScrollTop?: number;
  finalScrollHeight?: number;
  newTurnsDiscovered?: number;
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
  attachmentsExcludedByUser?: boolean;
  /** The user chose to copy anyway; files that could not be read are "not included" markers. */
  missingFilesAllowedByUser?: boolean;
  crawlerError?: string;
  /** Per-card outcome of real byte capture (no URLs with signatures, no bytes). */
  fileCardResolutions?: FileCardResolutionDiagnostic[];
  /** How MAIN-world file capture hooks were installed ('none' when unavailable). */
  fileCaptureMethod?: string;
  /** Completeness evidence */
  scrollContainerVisible?: boolean;
  finalAtOldestEdge?: boolean;
  /** Informational: "fallback-turn-N" numbers seen in unit keys and missing ranges */
  unitTurnRange?: [number, number];
  unitTurnGaps?: string[];
  customDetails?: Record<string, unknown>;
}

export interface FileCardResolutionDiagnostic {
  filename: string;
  turnKey: string;
  attempted: boolean;
  status: 'resolved' | 'unresolved';
  reason?: string;
  /**
   * page-fetch-capture: cloned from ChatGPT's own content fetch;
   * download-url-fetch: fetched with the download_url ChatGPT returned;
   * replayed-download: ChatGPT answered from its cache, so its own files/download request was
   * repeated in the page for this file id.
   */
  method?: 'page-fetch-capture' | 'download-url-fetch' | 'replayed-download';
  /** replayed-download only: 'page-template' (copied from ChatGPT's request) or 'fallback-query'. */
  replaySource?: string;
  /** Resolved (or retried) after the traversal, without clicking the card again. */
  latePass?: boolean;
  fileId?: string;
  downloadStatus?: string;
  httpStatus?: number;
  byteSize?: number;
  expectedByteSize?: number;
  sizeMismatch?: boolean;
  mimeType?: string;
  nameMatched?: boolean;
  eventsSeen?: string[];
  /** Content the page fetched during this card's window that belonged to something else. */
  unrelatedContentIgnored?: number;
  panelsOpened?: number;
  panelsStillOpen?: number;
  panelButtons?: Array<{ ariaLabel?: string; testId?: string; title?: string }>;
  attemptNumber?: number;
  durationMs?: number;
}

export interface FileCardCandidateDiagnostic {
  turnKey: string;
  unitKey?: string;
  relationToUserUnit: string;
  tagName: string;
  stableAttributes: Record<string, string>;
  hrefKind?: string;
  srcKind?: string;
  textFilenameCandidate?: string;
}

/**
 * One network / navigation / DOM URL signal observed while a resource card was probed.
 * URLs are always reduced to origin + pathname; query VALUES are never recorded.
 */
export interface ResourceCardProbeObservedUrl {
  kind: string;
  sanitizedUrl: string;
  /** Same URL with ID-like path segments templated, e.g. /files/{file-id}/download */
  urlPattern?: string;
  /** Names (never values) of query parameters */
  queryKeys?: string[];
  source?: 'main-world' | 'performance' | 'dom';
  method?: string;
  status?: number;
  contentType?: string;
  contentDisposition?: string;
  contentLength?: string;
  initiatorType?: string;
  transferSize?: number;
  decodedBodySize?: number;
  responseUrl?: string;
  /** Keys and value kinds of a small JSON response body (no values) */
  jsonShape?: unknown;
  hasDownloadAttr?: boolean;
  suppressed?: boolean;
  fileRelated?: boolean;
  durationMs?: number;
  /** Milliseconds relative to the card activation */
  offsetMs?: number;
}

export interface ResourceCardButtonState {
  ariaExpanded?: string;
  ariaPressed?: string;
  ariaHaspopup?: string;
  ariaControls?: string;
  dataState?: string;
  disabled?: boolean;
  inViewport?: boolean;
}

export interface ResourceCardProbeDiagnostic {
  filename: string;
  turnKey: string;
  unitKey?: string;
  /** true once probeResourceCard() was actually invoked for this card */
  attempted: boolean;
  /** true when the probe ran through activation and observation without throwing */
  completed?: boolean;
  /** Present only when attempted === false */
  notInvokedReason?: string;
  /** Last lifecycle stage reached: started | hooks_installed | activating | activated | observed | restored */
  stage?: string;
  elementWasConnected: boolean;
  result?: string;
  /** Every signal category observed (result is the most byte-relevant one) */
  signals?: string[];
  error?: string | null;
  buttonAriaLabel?: string;
  buttonClass?: string;
  spanTitle?: string;
  initialResourceCount?: number;
  newElementsCreated?: Array<{
    tagName: string;
    className?: string;
    attributes: Record<string, string>;
  }>;
  newModalsOrDialogs?: Array<{
    tagName: string;
    role?: string;
    ariaLabel?: string;
    testId?: string;
    textLength?: number;
    containsFilename?: boolean;
    hasIframe?: boolean;
    hasImage?: boolean;
    hasPre?: boolean;
    hasDownloadLink?: boolean;
    buttonLabels?: string[];
  }>;
  observedUrls?: ResourceCardProbeObservedUrl[];
  blobUrlsCreated?: Array<{
    objectType: string;
    size?: number;
    mimeType?: string;
    nameMatchesCard?: boolean;
    offsetMs?: number;
  }>;
  mainWorld?: {
    ready: boolean;
    method: string;
    hooks: string[];
    attempts: Array<{ method: string; ok: boolean; error?: string; durationMs?: number }>;
    eventsReceived: number;
    eventsDuringRestore?: number;
    cleanup?: string;
  };
  activation?: {
    method: string;
    dispatched: Array<{ type: string; defaultPrevented: boolean; error?: string }>;
    buttonBefore: ResourceCardButtonState;
    buttonAfter?: ResourceCardButtonState;
    buttonStillConnected?: boolean;
  };
  domChanges?: {
    addedElements: number;
    attributeChanges: number;
    dialogsOpened: number;
    tooltipsAdded: number;
    iframesAdded: number;
    imagesAdded: number;
    downloadLinksAdded: number;
  };
  focusBefore?: string;
  focusAfterActivation?: string;
  locationChanged?: boolean;
  locationAfter?: string;
  restore?: {
    closeButtonsClicked: number;
    escapeDispatched: boolean;
    dialogsStillOpen: number;
    focusRestored: boolean;
    scrollRestored: boolean;
    historyBackCalled: boolean;
    locationRestored?: boolean;
  };
  timings?: {
    hooksReadyMs?: number;
    activatedAtMs?: number;
    observationMs?: number;
    restoreMs?: number;
  };
  /** Where in the crawl the probe ran (filled by the crawler) */
  crawlContext?: {
    scanPass: number;
    scrollAttempts: number;
    containerScrollTop?: number;
    containerScrollHeight?: number;
    windowTurnCount: number;
    cardIndexInWindow: number;
    cardsDetectedSoFar: number;
    crawlElapsedMs: number;
  };
  probeDurationMs?: number;
  outcome?: string;
}

export function sanitizeUrlForDiagnostics(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    // Keep origin, pathname (strip search params and hash to avoid leaking query tokens/state)
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

export function generateDiagnosticReport(diag: AdapterDiagnostics): string {
  return JSON.stringify(diag, null, 2);
}
