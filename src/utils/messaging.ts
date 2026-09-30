/**
 * Typed cross-context message passing protocol
 */

import { PlatformId, ConversationSnapshot } from '../core/model/canonical';
import { CaptureOptions, CaptureProgress, ImportResult } from '../adapters/adapter';
import { AdapterDiagnostics } from '../core/diagnostics/diagnostics';
import type { PreparedHandoff } from '../core/handoff/strategies';
import type { WireHandoff } from '../core/handoff/wire-handoff';
import type { TrayBlob, TraySummary } from '../storage/tray-store';
import type { WireBytes } from './wire-bytes';
import type { MainWorldProbeInstallArgs } from '../adapters/chatgpt/probe-main-world';
import type { FileCaptureInstallArgs } from '../adapters/chatgpt/file-capture-main-world';

export type MessageType =
  | 'PING'
  | 'GET_PAGE_STATUS'
  | 'PAGE_STATUS_RESPONSE'
  | 'START_CAPTURE'
  | 'CAPTURE_PROGRESS'
  | 'CAPTURE_COMPLETE'
  | 'CAPTURE_ERROR'
  | 'CAPTURE_FINISHED'
  | 'ABORT_CAPTURE'
  | 'GET_DIAGNOSTICS'
  | 'DIAGNOSTICS_RESPONSE'
  | 'INJECT_HANDOFF'
  | 'CONTINUE_IN_TARGET'
  | 'CLAIM_PENDING_HANDOFF'
  | 'HANDOFF_RESULT'
  | 'DOWNLOAD_ARCHIVE'
  | 'PROBE_INSTALL_MAIN_WORLD'
  | 'FETCH_MEDIA';

/**
 * Content script -> background port that carries a finished capture into the tray. A port
 * reaches only the background, so the (possibly large) payload is not cloned into every open
 * extension page the way runtime.sendMessage would.
 */
export const TRAY_SAVE_PORT = 'cb-tray-save';

export interface BaseMessage {
  type: MessageType;
}

/** Readiness handshake: content scripts answer { ok: true, platformId }. */
export interface PingMessage extends BaseMessage {
  type: 'PING';
}

export interface GetPageStatusMessage extends BaseMessage {
  type: 'GET_PAGE_STATUS';
}

/** A capture belongs to the tab, not to the popup: it keeps running when the popup closes. */
export interface CaptureStateInfo {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt?: number;
  finishedAt?: number;
  progress?: CaptureProgress;
  error?: string;
  cancelled?: boolean;
  attachmentsExcluded?: boolean;
  /** Names of the files that could not be read when the copy failed because of them. */
  missingFiles?: string[];
}

export interface PageStatusResponse extends BaseMessage {
  type: 'PAGE_STATUS_RESPONSE';
  isSupported: boolean;
  platformId?: PlatformId;
  title?: string;
  detectedMessages: number;
  pageUrl?: string;
  capture?: CaptureStateInfo;
}

export interface StartCaptureMessage extends BaseMessage {
  type: 'START_CAPTURE';
  // The archive password never goes to the content script; encryption happens in the popup.
  options: CaptureOptions;
}

export interface CaptureProgressMessage extends BaseMessage {
  type: 'CAPTURE_PROGRESS';
  progress: CaptureProgress;
}

/** Answer to START_CAPTURE: the conversation is already in the tray. */
export interface CaptureCompleteMessage extends BaseMessage {
  type: 'CAPTURE_COMPLETE';
  summary: TraySummary;
}

export interface CaptureErrorMessage extends BaseMessage {
  type: 'CAPTURE_ERROR';
  error: string;
  cancelled?: boolean;
  missingFiles?: string[];
}

/** Broadcast by the content script when a capture ends, for a popup opened mid-capture. */
export interface CaptureFinishedMessage extends BaseMessage {
  type: 'CAPTURE_FINISHED';
  platformId: PlatformId;
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  missingFiles?: string[];
  summary?: TraySummary;
}

export interface AbortCaptureMessage extends BaseMessage {
  type: 'ABORT_CAPTURE';
}

export interface GetDiagnosticsMessage extends BaseMessage {
  type: 'GET_DIAGNOSTICS';
}

export interface DiagnosticsResponseMessage extends BaseMessage {
  type: 'DIAGNOSTICS_RESPONSE';
  diagnostics: AdapterDiagnostics;
}

/** Popup -> background: open a new chat on the target site and deliver the tray into it. */
export interface ContinueInTargetMessage extends BaseMessage {
  type: 'CONTINUE_IN_TARGET';
  targetPlatform: PlatformId;
  options?: { includeAttachments?: boolean };
}

export interface ContinueInTargetResponse {
  success: boolean;
  opened?: boolean;
  tabId?: number;
  message: string;
}

export interface DownloadArchiveMessage extends BaseMessage {
  type: 'DOWNLOAD_ARCHIVE';
  /** WireBytes; number[] is still accepted from older callers. */
  archiveBytes: WireBytes | number[];
  filename: string;
  /** Defaults to application/x-contextbridge */
  mimeType?: string;
  /** Ask where to save (default true). */
  saveAs?: boolean;
}

/**
 * Extension page -> content script.
 * mode 'await' (default): answers with the ImportResult.
 * mode 'background': answers { accepted } right away, then inserts once the page has focus and
 * reports through the in-page notice and HANDOFF_RESULT. Used when the popup closes itself.
 */
export interface InjectHandoffMessage extends BaseMessage {
  type: 'INJECT_HANDOFF';
  handoff: WireHandoff | PreparedHandoff;
  mode?: 'await' | 'background';
}

export interface InjectHandoffAck {
  accepted: boolean;
  message?: string;
}

/** Content script -> background, on page load: "is a new-chat delivery waiting for this tab?" */
export interface ClaimPendingHandoffMessage extends BaseMessage {
  type: 'CLAIM_PENDING_HANDOFF';
  platformId: PlatformId;
}

export interface ClaimPendingHandoffResponse {
  handoff: WireHandoff | null;
}

/** Content script -> background after any insertion, so the popup can show it later. */
export interface HandoffResultMessage extends BaseMessage {
  type: 'HANDOFF_RESULT';
  via: 'direct' | 'claim';
  result: ImportResult;
}

/** Stored in storage.local as lastHandoffResult. */
export interface LastHandoffResult {
  targetPlatform: string;
  success: boolean;
  message: string;
  attachedFiles?: string[];
  manualAttachmentRequiredFiles?: string[];
  filesNotConfirmed?: string[];
  filesUnverified?: string[];
  filesOverLimit?: string[];
  fileLimit?: number;
  failureReason?: ImportResult['failureReason'];
  at: number;
}

/** Payload posted on the TRAY_SAVE_PORT. */
export interface TraySaveCapturePayload {
  snapshot: ConversationSnapshot;
  blobs: TrayBlob[];
  attachmentsExcluded?: boolean;
}

export interface TraySaveResponse {
  ok: boolean;
  summary?: TraySummary;
  error?: string;
}

/**
 * Content script -> background: run one of the allow-listed hook installers in the page MAIN
 * world ('resource-card-probe' is the default for backward compatibility).
 */
export interface ProbeInstallMainWorldMessage extends BaseMessage {
  type: 'PROBE_INSTALL_MAIN_WORLD';
  hook?: 'resource-card-probe' | 'file-capture';
  args: MainWorldProbeInstallArgs | FileCaptureInstallArgs;
}

/**
 * Content script -> background: read a picture, video or file the chat page shows but the
 * content script may not fetch itself (cross-origin, no CORS headers). The background only
 * fetches https URLs on the extension's own host permissions.
 */
export interface FetchMediaMessage extends BaseMessage {
  type: 'FETCH_MEDIA';
  url: string;
}

export interface FetchMediaResponse {
  ok: boolean;
  data?: WireBytes;
  mimeType?: string;
  status?: number;
  error?: string;
}

export type ExtensionMessage =
  | FetchMediaMessage
  | PingMessage
  | GetPageStatusMessage
  | PageStatusResponse
  | StartCaptureMessage
  | CaptureProgressMessage
  | CaptureCompleteMessage
  | CaptureErrorMessage
  | CaptureFinishedMessage
  | AbortCaptureMessage
  | GetDiagnosticsMessage
  | DiagnosticsResponseMessage
  | ContinueInTargetMessage
  | DownloadArchiveMessage
  | InjectHandoffMessage
  | ClaimPendingHandoffMessage
  | HandoffResultMessage
  | ProbeInstallMainWorldMessage;
