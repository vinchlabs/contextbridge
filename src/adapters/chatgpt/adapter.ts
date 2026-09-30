/**
 * ChatGPT Platform Adapter
 * Supports modern virtualized DOM architecture and robust conversation recovery.
 */

import {
  ChatAdapter,
  CaptureOptions,
  CaptureProgress,
  ImportOptions,
  ImportResult,
} from '../adapter';
import {
  ConversationSnapshot,
  StoredBlob,
  ConversationMetadata,
  Message,
  CANONICAL_SCHEMA_VERSION,
} from '../../core/model/canonical';
import { PreparedHandoff, prepareHandoff } from '../../core/handoff/strategies';
import {
  AdapterDiagnostics,
  CrawlerCandidateDiagnostic,
  CrawlerIterationLog,
  FileCardCandidateDiagnostic,
  FileCardResolutionDiagnostic,
  ResourceCardProbeDiagnostic,
  sanitizeUrlForDiagnostics,
} from '../../core/diagnostics/diagnostics';
import { BlobStore } from '../../core/hashing/sha256';
import { CHATGPT_SELECTORS } from './selectors';
import {
  crawlChatGPTConversation,
  resolveConversationScroller,
  CrawlResult,
} from './crawler';
import { resolveChatGPTMedia } from './attachment-extractor';
import { injectChatGPTImport } from './importer';
import { extractConversationId } from './extractor';
import { conversationIdFromUrl, findActiveThreadRoot } from './active-thread';
import { CaptureIncompleteError } from '../../core/errors/errors';
import {
  saveLastChatGPTDiagnostics,
  loadLastChatGPTDiagnostics,
} from '../../storage/chatgpt-diagnostics-store';
import { requestFileCaptureInstall, requestMainWorldProbeInstall } from './probe-bridge';
import type { CapturedFileBytes } from './file-card-resolver';
import { markUnresolvedMediaParts } from '../../core/model/unresolved-media';

/**
 * Stores captured file-card bytes and points the matching file parts (same turn, same filename,
 * still a chatgpt-file:// placeholder) at their real SHA-256.
 */
export async function attachCapturedFileBytes(
  messages: Message[],
  captured: CapturedFileBytes[],
  blobStore: BlobStore
): Promise<number> {
  let patched = 0;
  for (const file of captured) {
    const meta = await blobStore.put(file.data, {
      mimeType: file.mimeType,
      filename: file.filename,
      role: 'user-upload',
      captureSource: 'chatgpt-file-card',
    });
    for (const msg of messages) {
      if (msg.role !== 'user' || msg.metadata?.turnKey !== file.turnKey) continue;
      for (const part of msg.content) {
        if (part.type === 'file' && part.filename === file.filename && part.blobSha256.startsWith('chatgpt-file://')) {
          part.blobSha256 = meta.sha256;
          part.byteSize = meta.byteSize;
          part.mimeType = file.mimeType;
          patched++;
        }
      }
    }
  }
  return patched;
}

export function cleanChatGPTTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\s*[-|·•—]\s*ChatGPT\s*$/i, '')
    .replace(/^ChatGPT\s*[-|·•—]\s*/i, '')
    .trim();
}

export class ChatGPTAdapter implements ChatAdapter {
  readonly id = 'chatgpt' as const;
  readonly displayName = 'ChatGPT';
  readonly supportedHostnames = ['chatgpt.com', 'chat.openai.com'];

  private lastCrawlStats: {
    crawlerIterations: number;
    capturedMessageCount: number;
    terminationReason: string;
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
    missingFilesAllowedByUser?: boolean;
    crawlerError?: string;
    fileCardResolutions?: FileCardResolutionDiagnostic[];
    fileCaptureMethod?: string;
    scrollContainerVisible?: boolean;
    finalAtOldestEdge?: boolean;
    unitTurnRange?: [number, number];
    unitTurnGaps?: string[];
    crawlerCandidates?: CrawlerCandidateDiagnostic[];
    iterationLogs?: CrawlerIterationLog[];
  } = {
    crawlerIterations: 0,
    capturedMessageCount: 0,
    terminationReason: 'none',
  };

  /** true once a capture ran in this content-script instance (stored stats are then stale). */
  private hasLiveCrawlStats = false;

  /** Maps crawler diagnostic details (checkpoint or CaptureIncompleteError) onto lastCrawlStats. */
  private applyCrawlDetails(details: Record<string, unknown>): void {
    const d = details as Record<string, any>;
    this.lastCrawlStats = {
      ...this.lastCrawlStats,
      crawlerIterations: typeof d.scrollAttempts === 'number' ? d.scrollAttempts : this.lastCrawlStats.crawlerIterations,
      capturedMessageCount:
        typeof d.capturedMessagesCount === 'number' ? d.capturedMessagesCount : this.lastCrawlStats.capturedMessageCount,
      terminationReason: typeof d.terminationReason === 'string' ? d.terminationReason : 'incomplete',
      scrollContainerDescription: d.scrollContainerDescription ?? this.lastCrawlStats.scrollContainerDescription,
      initialScrollTop: d.initialScrollTop ?? this.lastCrawlStats.initialScrollTop,
      initialScrollHeight: d.initialScrollHeight ?? this.lastCrawlStats.initialScrollHeight,
      initialClientHeight: d.initialClientHeight ?? this.lastCrawlStats.initialClientHeight,
      finalScrollTop: d.finalScrollTop ?? this.lastCrawlStats.finalScrollTop,
      finalScrollHeight: d.finalScrollHeight ?? this.lastCrawlStats.finalScrollHeight,
      initialVisibleTurnCount: d.initialVisibleTurnCount ?? this.lastCrawlStats.initialVisibleTurnCount,
      newTurnsDiscovered: d.newTurnsDiscovered ?? this.lastCrawlStats.newTurnsDiscovered,
      oldestTurnKeySeen: d.oldestTurnKeySeen ?? this.lastCrawlStats.oldestTurnKeySeen,
      newestTurnKeySeen: d.newestTurnKeySeen ?? this.lastCrawlStats.newestTurnKeySeen,
      // Keep the crawler's real value (e.g. true for unresolved_user_attachment).
      beginningReached: typeof d.beginningReached === 'boolean' ? d.beginningReached : false,
      assistantOnlyTurns: d.assistantOnlyTurns ?? this.lastCrawlStats.assistantOnlyTurns,
      userUnitsWithNoCanonicalMessage: d.userUnitsWithNoCanonicalMessage ?? this.lastCrawlStats.userUnitsWithNoCanonicalMessage,
      attachmentSentinelUnits: d.attachmentSentinelUnits ?? this.lastCrawlStats.attachmentSentinelUnits,
      resolvedAttachmentOnlyUnits: d.resolvedAttachmentOnlyUnits ?? this.lastCrawlStats.resolvedAttachmentOnlyUnits,
      unresolvedAttachmentOnlyUnits: d.unresolvedAttachmentOnlyUnits ?? this.lastCrawlStats.unresolvedAttachmentOnlyUnits,
      fileCardsDetected: d.fileCardsDetected ?? this.lastCrawlStats.fileCardsDetected,
      fileCardsResolved: d.fileCardsResolved ?? this.lastCrawlStats.fileCardsResolved,
      fileCardsUnresolved: d.fileCardsUnresolved ?? this.lastCrawlStats.fileCardsUnresolved,
      fileCardCandidatesObserved: d.fileCardCandidatesObserved ?? this.lastCrawlStats.fileCardCandidatesObserved,
      resourceCardProbes: d.resourceCardProbes ?? this.lastCrawlStats.resourceCardProbes,
      resourceCardProbeAttempts: d.resourceCardProbeAttempts ?? this.lastCrawlStats.resourceCardProbeAttempts,
      resourceCardProbeSuccesses: d.resourceCardProbeSuccesses ?? this.lastCrawlStats.resourceCardProbeSuccesses,
      resourceCardProbeFailures: d.resourceCardProbeFailures ?? this.lastCrawlStats.resourceCardProbeFailures,
      realFileBlobsCaptured: d.realFileBlobsCaptured ?? this.lastCrawlStats.realFileBlobsCaptured ?? 0,
      attachmentsExcludedByUser: d.attachmentsExcludedByUser ?? this.lastCrawlStats.attachmentsExcludedByUser,
      missingFilesAllowedByUser: d.missingFilesAllowedByUser ?? this.lastCrawlStats.missingFilesAllowedByUser,
      fileCardResolutions: d.fileCardResolutions ?? this.lastCrawlStats.fileCardResolutions,
      fileCaptureMethod: d.fileCaptureMethod ?? this.lastCrawlStats.fileCaptureMethod,
      scrollContainerVisible: d.scrollContainerVisible ?? this.lastCrawlStats.scrollContainerVisible,
      finalAtOldestEdge: d.finalAtOldestEdge ?? this.lastCrawlStats.finalAtOldestEdge,
      unitTurnRange: d.unitTurnRange ?? this.lastCrawlStats.unitTurnRange,
      unitTurnGaps: d.unitTurnGaps ?? this.lastCrawlStats.unitTurnGaps,
      crawlerCandidates: d.crawlerCandidates ?? this.lastCrawlStats.crawlerCandidates,
      iterationLogs: d.iterationLogs ?? this.lastCrawlStats.iterationLogs,
    };
  }

  detect(urlStr?: string): boolean {
    const targetUrl = urlStr || (typeof window !== 'undefined' ? window.location.href : '');
    try {
      const parsed = new URL(targetUrl);
      return this.supportedHostnames.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  /**
   * Title detection: document.title is the PRIMARY source.
   * Strips suffixes like " | ChatGPT" or " - ChatGPT".
   * Header and sidebar navigation are fallback only.
   */
  async getConversationMetadata(doc: Document = document): Promise<ConversationMetadata> {
    let title = '';

    // 1. Primary: document.title
    if (doc.title) {
      const cleaned = cleanChatGPTTitle(doc.title);
      if (cleaned && cleaned.toLowerCase() !== 'chatgpt') {
        title = cleaned;
      }
    }

    // 2. Fallback: Header h1
    if (!title) {
      const headerTitle = doc.querySelector(CHATGPT_SELECTORS.METADATA.CONVERSATION_TITLE_HEADER)?.textContent?.trim();
      if (headerTitle) {
        title = cleanChatGPTTitle(headerTitle);
      }
    }

    // 3. Fallback: sidebar active link / nav
    if (!title) {
      const navActive = doc.querySelector(CHATGPT_SELECTORS.METADATA.SIDEBAR_ACTIVE_LINK)?.textContent?.trim();
      if (navActive) {
        title = cleanChatGPTTitle(navActive);
      }
    }

    // 4. Default fallback
    if (!title) {
      title = 'ChatGPT Conversation';
    }

    // Scoped to the thread on screen: a document-wide lookup can hit a hidden app-shell page.
    const pageHref = doc.defaultView?.location?.href ?? (typeof window !== 'undefined' ? window.location.href : undefined);
    const conversationId = extractConversationId(findActiveThreadRoot(doc)) ?? conversationIdFromUrl(pageHref);

    return {
      id: conversationId,
      title,
      createdAt: new Date().toISOString(),
    };
  }

  async captureConversation(
    options: CaptureOptions = {},
    onProgress?: (progress: CaptureProgress) => void,
    signal?: AbortSignal,
    doc: Document = document
  ): Promise<{ snapshot: ConversationSnapshot; blobs: Map<string, StoredBlob> }> {
    onProgress?.({
      phase: 'detecting',
      messagesFound: 0,
      imagesFound: 0,
      filesFound: 0,
      currentOperation: 'Initializing ChatGPT capture...',
    });

    const meta = await this.getConversationMetadata(doc);

    // Fresh in-memory stats for THIS capture. getDiagnostics() must never merge a previous
    // run's stored stats over them (that used to happen whenever scrollAttempts was 0).
    this.hasLiveCrawlStats = true;
    this.lastCrawlStats = {
      crawlerIterations: 0,
      capturedMessageCount: 0,
      terminationReason: 'in_progress',
    };

    // 1. Crawl virtualized message history
    let crawlResult: CrawlResult;
    try {
      crawlResult = await crawlChatGPTConversation(doc, options, onProgress, signal, {
        installMainWorldProbe: requestMainWorldProbeInstall,
        installMainWorldFileCapture: requestFileCaptureInstall,
        // Live checkpoints (e.g. right before/after the resource-card probe) are persisted
        // immediately, so the probe result survives even if the page unloads mid-capture.
        onDiagnosticsCheckpoint: async (details) => {
          this.applyCrawlDetails(details);
          await this.persistLastDiagnostics(doc);
        },
      });
    } catch (err) {
      if (err instanceof CaptureIncompleteError && err.details) {
        this.applyCrawlDetails(err.details as Record<string, unknown>);
      } else {
        this.lastCrawlStats.terminationReason = 'crawler_exception';
        this.lastCrawlStats.crawlerError = err instanceof Error ? err.message : String(err);
      }
      await this.persistLastDiagnostics(doc);
      throw err;
    }

    this.lastCrawlStats = {
      crawlerIterations: crawlResult.scrollAttempts,
      capturedMessageCount: crawlResult.results.length,
      terminationReason: crawlResult.terminationReason,
      scrollContainerTag: crawlResult.scrollContainerTag,
      scrollContainerDescription: crawlResult.scrollContainerDescription,
      scrollContainerAttributes: crawlResult.scrollContainerAttributes,
      initialScrollTop: crawlResult.initialScrollTop,
      initialScrollHeight: crawlResult.initialScrollHeight,
      initialClientHeight: crawlResult.initialClientHeight,
      finalScrollTop: crawlResult.finalScrollTop,
      finalScrollHeight: crawlResult.finalScrollHeight,
      initialVisibleTurnCount: crawlResult.initialVisibleTurnCount,
      newTurnsDiscovered: crawlResult.newTurnsDiscovered,
      oldestTurnKeySeen: crawlResult.oldestTurnKeySeen,
      newestTurnKeySeen: crawlResult.newestTurnKeySeen,
      beginningReached: crawlResult.beginningReached,
      assistantOnlyTurns: crawlResult.assistantOnlyTurns,
      userUnitsWithNoCanonicalMessage: crawlResult.userUnitsWithNoCanonicalMessage,
      attachmentSentinelUnits: crawlResult.attachmentSentinelUnits,
      resolvedAttachmentOnlyUnits: crawlResult.resolvedAttachmentOnlyUnits,
      unresolvedAttachmentOnlyUnits: crawlResult.unresolvedAttachmentOnlyUnits,
      fileCardsDetected: crawlResult.fileCardsDetected,
      fileCardsResolved: crawlResult.fileCardsResolved,
      fileCardsUnresolved: crawlResult.fileCardsUnresolved,
      fileCardCandidatesObserved: crawlResult.fileCardCandidatesObserved,
      resourceCardProbes: crawlResult.resourceCardProbes,
      resourceCardProbeAttempts: crawlResult.resourceCardProbeAttempts,
      resourceCardProbeSuccesses: crawlResult.resourceCardProbeSuccesses,
      resourceCardProbeFailures: crawlResult.resourceCardProbeFailures,
      realFileBlobsCaptured: crawlResult.realFileBlobsCaptured ?? 0,
      attachmentsExcludedByUser: crawlResult.attachmentsExcludedByUser,
      missingFilesAllowedByUser: crawlResult.missingFilesAllowedByUser,
      fileCardResolutions: crawlResult.fileCardResolutions,
      fileCaptureMethod: crawlResult.fileCaptureMethod,
      scrollContainerVisible: crawlResult.scrollContainerVisible,
      finalAtOldestEdge: crawlResult.finalAtOldestEdge,
      unitTurnRange: crawlResult.unitTurnRange,
      unitTurnGaps: crawlResult.unitTurnGaps,
      crawlerCandidates: crawlResult.crawlerCandidates,
      iterationLogs: crawlResult.iterationLogs,
    };
    await this.persistLastDiagnostics(doc);

    // A cancelled capture must never be delivered as a (partial) success.
    if (signal?.aborted || crawlResult.terminationReason === 'aborted') {
      this.lastCrawlStats.terminationReason = 'aborted';
      await this.persistLastDiagnostics(doc);
      throw new CaptureIncompleteError('Capture cancelled by user.', { terminationReason: 'aborted' });
    }

    const messages = crawlResult.results.map((r) => r.message);
    // chatgpt-file:// references are placeholders for file cards; their bytes come from the
    // crawler's live capture below and can never be fetched by URL.
    const allMediaRefs = crawlResult.results
      .flatMap((r) => r.mediaRefs)
      .filter((ref) => !ref.url.startsWith('chatgpt-file://'));
    const attachmentsExcluded = options.includeAttachments === false;

    // 2. Resolve media attachments
    const blobStore = new BlobStore();
    try {
      // File cards: bytes captured through ChatGPT's own files/download -> download_url chain.
      await attachCapturedFileBytes(messages, crawlResult.capturedFileBytes ?? [], blobStore);
      if (!attachmentsExcluded && allMediaRefs.length > 0) {
        await resolveChatGPTMedia(
          messages,
          allMediaRefs,
          blobStore,
          onProgress,
          signal,
          options.allowMissingFiles === true
        );
      }
      // Whatever is still a placeholder (excluded by the user, or a non-user asset that could not
      // be fetched) becomes an explicit "not included" marker instead of a dangling URL that
      // would fail archive validation.
      markUnresolvedMediaParts(
        messages,
        (sha) => blobStore.has(sha),
        attachmentsExcluded ? 'excluded_by_user' : 'not_captured'
      );
      if (attachmentsExcluded || crawlResult.missingFilesAllowedByUser) {
        for (const msg of messages) {
          if (msg.role === 'user' && msg.content.length === 0 && msg.metadata?.isAttachmentSentinel) {
            msg.content.push(
              attachmentsExcluded
                ? {
                    type: 'unknown',
                    platformType: 'omitted-file',
                    rawText: '[Attachment not included (attachments were excluded from this export)]',
                    metadata: { reason: 'excluded_by_user', originalType: 'file' },
                  }
                : {
                    type: 'unknown',
                    platformType: 'uncaptured-file',
                    rawText: '[Attachment not included (its bytes could not be captured)]',
                    metadata: { reason: 'not_captured', originalType: 'file' },
                  }
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof CaptureIncompleteError && err.details) {
        const details = err.details as Record<string, any>;
        if (details.terminationReason) {
          this.lastCrawlStats.terminationReason = details.terminationReason;
        }
      }
      await this.persistLastDiagnostics(doc);
      throw err;
    }

    const realFileBlobsCaptured = Array.from(blobStore.getAll().values()).filter(
      (b) => b.metadata.role === 'user-upload' && b.metadata.captureSource === 'chatgpt-file-card'
    ).length;
    this.lastCrawlStats.realFileBlobsCaptured = realFileBlobsCaptured;
    await this.persistLastDiagnostics(doc);

    onProgress?.({
      phase: 'finalizing',
      messagesFound: messages.length,
      imagesFound: blobStore.count,
      filesFound: 0,
      currentOperation: 'Finalizing snapshot...',
    });

    const pageUrl = typeof window !== 'undefined' ? window.location.href : '';

    const snapshot: ConversationSnapshot = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      id: `chatgpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourcePlatform: 'chatgpt',
      sourceConversationId: meta.id,
      title: meta.title,
      sourceUrl: pageUrl,
      capturedAt: new Date().toISOString(),
      messages,
      attachments: blobStore.getMetadataList(),
    };

    return {
      snapshot,
      blobs: blobStore.getAll(),
    };
  }

  async prepareImport(
    bundle: { snapshot: ConversationSnapshot; blobs: Map<string, StoredBlob> },
    options: ImportOptions = {}
  ): Promise<PreparedHandoff> {
    return prepareHandoff(bundle.snapshot, bundle.blobs, this.id, {
      strategy: options.strategy,
      includeMediaFiles: options.includeAttachments,
    });
  }

  async injectHandoff(handoff: PreparedHandoff, doc: Document = document): Promise<ImportResult> {
    return injectChatGPTImport(handoff, doc);
  }

  private async persistLastDiagnostics(doc: Document = document): Promise<void> {
    try {
      const diag = await this.getDiagnostics(doc);
      await saveLastChatGPTDiagnostics({
        diagnostics: diag,
        crawlStats: this.lastCrawlStats,
      });
    } catch {
      // Ignore background storage error
    }
  }

  async getDiagnostics(doc: Document = document): Promise<AdapterDiagnostics> {
    // Only fall back to stored stats when this instance has not captured anything yet.
    if (!this.hasLiveCrawlStats) {
      try {
        const stored = await loadLastChatGPTDiagnostics();
        if (stored?.crawlStats) {
          this.lastCrawlStats = { ...this.lastCrawlStats, ...stored.crawlStats };
        } else if (stored?.diagnostics) {
          const d = stored.diagnostics;
          this.lastCrawlStats = {
            crawlerIterations: d.crawlerIterations || d.crawlerScrollAttempts || 0,
            capturedMessageCount: d.capturedMessageCount || 0,
            terminationReason: d.crawlerTerminationReason || 'stored',
            scrollContainerDescription: d.scrollContainerDescription,
            initialScrollTop: d.initialScrollTop,
            initialScrollHeight: d.initialScrollHeight,
            initialClientHeight: d.initialClientHeight,
            finalScrollTop: d.finalScrollTop,
            initialVisibleTurnCount: d.initialVisibleTurnCount,
            newTurnsDiscovered: d.newTurnsDiscovered,
            oldestTurnKeySeen: d.oldestTurnKeySeen,
            newestTurnKeySeen: d.newestTurnKeySeen,
            beginningReached: d.beginningReached,
            assistantOnlyTurns: d.assistantOnlyTurns,
            userUnitsWithNoCanonicalMessage: d.userUnitsWithNoCanonicalMessage,
            attachmentSentinelUnits: d.attachmentSentinelUnits,
            resolvedAttachmentOnlyUnits: d.resolvedAttachmentOnlyUnits,
            unresolvedAttachmentOnlyUnits: d.unresolvedAttachmentOnlyUnits,
            fileCardsDetected: d.fileCardsDetected,
            fileCardsResolved: d.fileCardsResolved,
            fileCardsUnresolved: d.fileCardsUnresolved,
            fileCardCandidatesObserved: d.fileCardCandidatesObserved,
            resourceCardProbes: d.resourceCardProbes,
            resourceCardProbeAttempts: d.resourceCardProbeAttempts ?? (stored.crawlStats?.resourceCardProbeAttempts as number | undefined),
            resourceCardProbeSuccesses: d.resourceCardProbeSuccesses ?? (stored.crawlStats?.resourceCardProbeSuccesses as number | undefined),
            resourceCardProbeFailures: d.resourceCardProbeFailures ?? (stored.crawlStats?.resourceCardProbeFailures as number | undefined),
            realFileBlobsCaptured: d.realFileBlobsCaptured,
            crawlerCandidates: d.crawlerCandidates,
            iterationLogs: d.iterationLogs,
          };
        }
      } catch {
        // Ignore background storage read error
      }
    }

    const pageUrl = typeof window !== 'undefined' ? window.location.href : '';
    const turnCount = doc.querySelectorAll(CHATGPT_SELECTORS.TURNS.PRIMARY).length;
    const fallbackArticleCount = doc.querySelectorAll(CHATGPT_SELECTORS.TURNS.FALLBACK_ARTICLE).length;
    const fallbackTestIdCount = doc.querySelectorAll(CHATGPT_SELECTORS.TURNS.FALLBACK_TESTID).length;
    const unitCount =
      doc.querySelectorAll(CHATGPT_SELECTORS.UNITS.PRIMARY).length ||
      doc.querySelectorAll(CHATGPT_SELECTORS.UNITS.FALLBACK).length;

    const distinctMessageIds = new Set<string>();
    doc.querySelectorAll(CHATGPT_SELECTORS.IDENTIFIERS.SELECTION_MESSAGE_ID).forEach((el) => {
      const id = el.getAttribute('data-chatgpt-selection-message-id');
      if (id) distinctMessageIds.add(id);
    });
    doc.querySelectorAll(CHATGPT_SELECTORS.IDENTIFIERS.SEARCH_MESSAGE_IDS).forEach((el) => {
      const ids = el.getAttribute('data-chatgpt-search-message-ids');
      if (ids) {
        ids.trim().split(/\s+/).forEach((i) => distinctMessageIds.add(i));
      }
    });

    const convId = extractConversationId(doc);

    let candidates = this.lastCrawlStats.crawlerCandidates;
    if (!candidates || candidates.length === 0) {
      const resolved = resolveConversationScroller(doc);
      candidates = resolved.diagnostics;
    }

    return {
      timestamp: new Date().toISOString(),
      adapterId: this.id,
      adapterVersion: '1.0.0',
      sanitizedUrl: sanitizeUrlForDiagnostics(pageUrl),
      selectorStrategiesEvaluated: [
        {
          strategyName: 'primary_turn_key',
          found: turnCount > 0,
          matchCount: turnCount,
        },
        {
          strategyName: 'primary_unit_key',
          found: unitCount > 0,
          matchCount: unitCount,
        },
        {
          strategyName: 'fallback_article',
          found: fallbackArticleCount > 0,
          matchCount: fallbackArticleCount,
        },
        {
          strategyName: 'fallback_testid',
          found: fallbackTestIdCount > 0,
          matchCount: fallbackTestIdCount,
        },
      ],
      detectedMessagesCount: unitCount > 0 ? unitCount : (turnCount > 0 ? turnCount : fallbackArticleCount),
      unresolvedElementsCount: 0,
      crawlerScrollAttempts: this.lastCrawlStats.crawlerIterations,
      crawlerTerminationReason: this.lastCrawlStats.terminationReason || 'none',
      attachmentsDetected: 0,
      attachmentBytesTotal: 0,
      browserEnvironment: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
        compressionStreamSupported: typeof CompressionStream !== 'undefined',
        cryptoSubtleSupported: typeof crypto !== 'undefined' && Boolean(crypto.subtle),
      },
      chatgptTurnCount: turnCount,
      chatgptUnitCount: unitCount,
      messageIdsFound: distinctMessageIds.size,
      conversationIdFound: Boolean(convId),
      crawlerIterations: this.lastCrawlStats.crawlerIterations,
      capturedMessageCount: this.lastCrawlStats.capturedMessageCount,
      initialVisibleTurnCount: this.lastCrawlStats.initialVisibleTurnCount,
      oldestTurnKeySeen: this.lastCrawlStats.oldestTurnKeySeen,
      newestTurnKeySeen: this.lastCrawlStats.newestTurnKeySeen,
      scrollContainerDescription: this.lastCrawlStats.scrollContainerDescription,
      initialScrollTop: this.lastCrawlStats.initialScrollTop,
      initialScrollHeight: this.lastCrawlStats.initialScrollHeight,
      initialClientHeight: this.lastCrawlStats.initialClientHeight,
      finalScrollTop: this.lastCrawlStats.finalScrollTop,
      finalScrollHeight: this.lastCrawlStats.finalScrollHeight,
      newTurnsDiscovered: this.lastCrawlStats.newTurnsDiscovered,
      beginningReached: this.lastCrawlStats.beginningReached,
      assistantOnlyTurns: this.lastCrawlStats.assistantOnlyTurns ?? 0,
      userUnitsWithNoCanonicalMessage: this.lastCrawlStats.userUnitsWithNoCanonicalMessage ?? 0,
      attachmentSentinelUnits: this.lastCrawlStats.attachmentSentinelUnits ?? 0,
      resolvedAttachmentOnlyUnits: this.lastCrawlStats.resolvedAttachmentOnlyUnits ?? 0,
      unresolvedAttachmentOnlyUnits: this.lastCrawlStats.unresolvedAttachmentOnlyUnits ?? 0,
      fileCardsDetected: this.lastCrawlStats.fileCardsDetected ?? 0,
      fileCardsResolved: this.lastCrawlStats.fileCardsResolved ?? 0,
      fileCardsUnresolved: this.lastCrawlStats.fileCardsUnresolved ?? 0,
      fileCardCandidatesObserved: this.lastCrawlStats.fileCardCandidatesObserved,
      resourceCardProbes: this.lastCrawlStats.resourceCardProbes,
      resourceCardProbeAttempts: this.lastCrawlStats.resourceCardProbeAttempts ?? 0,
      resourceCardProbeSuccesses: this.lastCrawlStats.resourceCardProbeSuccesses ?? 0,
      resourceCardProbeFailures: this.lastCrawlStats.resourceCardProbeFailures ?? 0,
      realFileBlobsCaptured: this.lastCrawlStats.realFileBlobsCaptured ?? 0,
      attachmentsExcludedByUser: this.lastCrawlStats.attachmentsExcludedByUser,
      missingFilesAllowedByUser: this.lastCrawlStats.missingFilesAllowedByUser,
      crawlerError: this.lastCrawlStats.crawlerError,
      fileCardResolutions: this.lastCrawlStats.fileCardResolutions,
      fileCaptureMethod: this.lastCrawlStats.fileCaptureMethod,
      scrollContainerVisible: this.lastCrawlStats.scrollContainerVisible,
      finalAtOldestEdge: this.lastCrawlStats.finalAtOldestEdge,
      unitTurnRange: this.lastCrawlStats.unitTurnRange,
      unitTurnGaps: this.lastCrawlStats.unitTurnGaps,
      crawlerCandidates: candidates,
      iterationLogs: this.lastCrawlStats.iterationLogs,
    };
  }
}
