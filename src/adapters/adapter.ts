/**
 * Core ChatAdapter interface for ContextBridge platform adapters
 */

import {
  PlatformId,
  ConversationSnapshot,
  StoredBlob,
  ConversationMetadata,
} from '../core/model/canonical';
import { PreparedHandoff } from '../core/handoff/strategies';
import { AdapterDiagnostics } from '../core/diagnostics/diagnostics';

export interface CaptureOptions {
  includeAttachments?: boolean;
  maxScrollAttempts?: number;
  scrollDelayMs?: number;
  maxCrawlDurationMs?: number;
  /** Upper bound of the diagnostic resource-card observation window (ms, default 2500). */
  probeTimeoutMs?: number;
  /**
   * Development diagnostic (ChatGPT): activate the first unresolved, still-mounted file card
   * once per capture and record everything ChatGPT does. Opt-in (default false) now that real
   * capture uses the mechanism it revealed; ignored when includeAttachments is false.
   */
  resourceCardProbe?: boolean;
  /** ChatGPT: capture real bytes of uploaded-file cards (default true unless includeAttachments is false). */
  resolveFileCards?: boolean;
  /** ChatGPT: per-card wait for ChatGPT's files/download answer after the click (ms, default 12000). */
  fileCaptureTimeoutMs?: number;
  /**
   * The user chose to copy anyway after a capture named files it could not read: those files
   * become explicit "not included" markers instead of failing the capture. Default false.
   */
  allowMissingFiles?: boolean;
}

export interface CaptureProgress {
  phase: 'detecting' | 'crawling' | 'extracting' | 'resolving-media' | 'finalizing';
  messagesFound: number;
  imagesFound: number;
  filesFound: number;
  currentOperation?: string;
}

export interface ImportOptions {
  strategy?: 'FULL' | 'RECENT_PLUS_ARCHIVE';
  includeAttachments?: boolean;
}

export interface ImportResult {
  success: boolean;
  targetPlatform: PlatformId;
  strategyUsed: string;
  injectedPromptLength: number;
  /** Files the target page showed after they were handed over. */
  attachedFilesCount: number;
  attachedFiles?: string[];
  /** Everything the user may still have to attach: not confirmed, unverified and over the limit. */
  manualAttachmentRequiredFiles?: string[];
  /** Handed over, but the page did not show them (and gave no sign of taking them). */
  filesNotConfirmed?: string[];
  /** The page took the hand-over but showed none of these in a recognisable way: check them. */
  filesUnverified?: string[];
  /** Left out because the target takes at most `fileLimit` files per message. */
  filesOverLimit?: string[];
  fileLimit?: number;
  message: string;
  /**
   * Why it failed, for recovery: 'composer_not_found' (not signed in / page not ready, worth a
   * retry after reload), 'text_not_verified' (text may be missing), 'error' (exception).
   */
  failureReason?: 'composer_not_found' | 'text_not_verified' | 'error';
  /**
   * The way after which the page showed the files: 'file-input', 'paste', 'drop'; 'none' when
   * it showed none (or there were no files), 'unsupported' when no way could be carried out.
   */
  attachMethod?: string;
}

export interface ChatAdapter {
  readonly id: PlatformId;
  readonly displayName: string;
  readonly supportedHostnames: string[];

  /**
   * Returns true if this adapter matches the given URL or the current window.location.
   */
  detect(url?: string): boolean;

  /**
   * Obtains conversation metadata (title, model, IDs) from the page.
   */
  getConversationMetadata(doc?: Document): Promise<ConversationMetadata>;

  /**
   * Crawls virtualized DOM, extracts messages and resolves attachments, returning
   * a canonical ConversationSnapshot and content-addressed blobs.
   */
  captureConversation(
    options?: CaptureOptions,
    onProgress?: (progress: CaptureProgress) => void,
    signal?: AbortSignal,
    doc?: Document
  ): Promise<{ snapshot: ConversationSnapshot; blobs: Map<string, StoredBlob> }>;

  /**
   * Translates a snapshot and blobs into target-compatible handoff material.
   */
  prepareImport(
    bundle: { snapshot: ConversationSnapshot; blobs: Map<string, StoredBlob> },
    options?: ImportOptions
  ): Promise<PreparedHandoff>;

  /**
   * Injects the prepared handoff into the target platform's active compose box and file input.
   */
  injectHandoff(
    handoff: PreparedHandoff,
    doc?: Document
  ): Promise<ImportResult>;

  /**
   * Exposes sanitized adapter diagnostics.
   */
  getDiagnostics(doc?: Document): Promise<AdapterDiagnostics>;
}
