/**
 * Google Gemini Platform Adapter
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
  CANONICAL_SCHEMA_VERSION,
} from '../../core/model/canonical';
import { PreparedHandoff, prepareHandoff } from '../../core/handoff/strategies';
import { AdapterDiagnostics, sanitizeUrlForDiagnostics } from '../../core/diagnostics/diagnostics';
import { BlobStore } from '../../core/hashing/sha256';
import { GEMINI_SELECTORS } from './selectors';
import { crawlGeminiConversation } from './crawler';
import { resolveChatGPTMedia } from '../chatgpt/attachment-extractor';
import { assertSimpleCrawlComplete } from '../simple-crawler';
import { markUnresolvedMediaParts } from '../../core/model/unresolved-media';
import { injectGeminiImport } from './importer';

export class GeminiAdapter implements ChatAdapter {
  readonly id = 'gemini' as const;
  readonly displayName = 'Google Gemini';
  readonly supportedHostnames = ['gemini.google.com'];

  detect(urlStr?: string): boolean {
    const targetUrl = urlStr || (typeof window !== 'undefined' ? window.location.href : '');
    try {
      const parsed = new URL(targetUrl);
      return this.supportedHostnames.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
    } catch {
      return false;
    }
  }

  async getConversationMetadata(doc: Document = document): Promise<ConversationMetadata> {
    const titleEl = doc.querySelector(GEMINI_SELECTORS.METADATA.TITLE) || doc.querySelector('title');
    const title = titleEl?.textContent?.replace(/ - Gemini$/, '').trim() || 'Gemini Conversation';

    return {
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
      currentOperation: 'Initializing Gemini capture...',
    });

    const meta = await this.getConversationMetadata(doc);
    const crawlResult = await crawlGeminiConversation(doc, options, onProgress, signal);
    // Cancelled, truncated or empty captures are errors, never a (partial) success.
    assertSimpleCrawlComplete(crawlResult, signal, 'Gemini');

    const messages = crawlResult.results.map((r) => r.message);
    const allMediaRefs = crawlResult.results.flatMap((r) => r.mediaRefs);
    const attachmentsExcluded = options.includeAttachments === false;

    const blobStore = new BlobStore();
    if (!attachmentsExcluded && allMediaRefs.length > 0) {
      await resolveChatGPTMedia(messages, allMediaRefs, blobStore, onProgress, signal, options.allowMissingFiles === true);
    }
    // Remaining URL placeholders would fail archive validation and leak provider URLs.
    markUnresolvedMediaParts(messages, (sha) => blobStore.has(sha), attachmentsExcluded ? 'excluded_by_user' : 'not_captured');

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
      id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sourcePlatform: 'gemini',
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
    return injectGeminiImport(handoff, doc);
  }

  async getDiagnostics(doc: Document = document): Promise<AdapterDiagnostics> {
    const pageUrl = typeof window !== 'undefined' ? window.location.href : '';
    const turnCount = doc.querySelectorAll(GEMINI_SELECTORS.TURNS.COMBINED_TURNS).length;

    return {
      timestamp: new Date().toISOString(),
      adapterId: this.id,
      adapterVersion: '1.0.0',
      sanitizedUrl: sanitizeUrlForDiagnostics(pageUrl),
      selectorStrategiesEvaluated: [
        {
          strategyName: 'gemini_turns',
          found: turnCount > 0,
          matchCount: turnCount,
        },
      ],
      detectedMessagesCount: turnCount,
      unresolvedElementsCount: 0,
      crawlerScrollAttempts: 0,
      crawlerTerminationReason: 'none',
      attachmentsDetected: 0,
      attachmentBytesTotal: 0,
      browserEnvironment: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
        compressionStreamSupported: typeof CompressionStream !== 'undefined',
        cryptoSubtleSupported: typeof crypto !== 'undefined' && Boolean(crypto.subtle),
      },
    };
  }
}
