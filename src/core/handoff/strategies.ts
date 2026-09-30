/**
 * Target Handoff Strategies
 * Handles context-window awareness, active window vs full reference transcript,
 * and media reconstruction.
 */

import { ConversationSnapshot, StoredBlob, Message } from '../model/canonical';
import { ensureChronologicalOrder } from '../model/validation';
import { platformInfo } from '../platforms';
import { renderTranscript, renderMessage, type AttachmentRefs } from './renderer';
import { generateBootstrapPrompt, formatPlatformDisplayName } from './bootstrap';
import { planAttachments } from './attachment-plan';

export type HandoffStrategyType = 'FULL' | 'RECENT_PLUS_ARCHIVE';

export interface PreparedHandoffFile {
  filename: string;
  data: Uint8Array;
  mimeType: string;
}

export interface HandoffLimits {
  strategy?: HandoffStrategyType;
  maxActivePromptTokens?: number; // e.g. ~3500 tokens
  maxActivePromptChars?: number;  // or explicit char limit
  includeMediaFiles?: boolean;
  /**
   * Most files the target takes in one message (transcript.md included). Default: the target
   * platform's limit; unlimited for unknown targets.
   */
  maxFiles?: number;
}

export interface HandoffMetadata {
  sourcePlatform: string;
  targetPlatform: string;
  conversationTitle: string;
  sourceMessageCount: number;
  inlineMessageCount: number;
  transcriptMessageCount: number;
  imagesCount: number;
  filesCount: number;
  hasAttachedTranscript: boolean;
  estimatedTokens: number;
  /** Readable files left out because the target takes at most `fileLimit` files per message. */
  filesOverLimit?: string[];
  fileLimit?: number;
  /** Files of types the chat sites do not read; not attached. */
  unsupportedFiles?: string[];
  /** ContextBridge archives found in the chat; never uploaded. */
  archiveFiles?: string[];
}

export interface PreparedHandoff {
  targetPlatform: string;
  strategy: HandoffStrategyType;
  instructionText?: string;
  activeWindowMarkdown?: string;
  fullTranscriptMarkdown?: string;
  promptText: string;
  files: PreparedHandoffFile[];
  attachments?: PreparedHandoffFile[];
  metadata?: HandoffMetadata;
  stats: {
    totalMessages: number;
    activePromptMessages: number;
    attachedFilesCount: number;
    estimatedTokens: number;
    isTruncatedToRecent: boolean;
    sourceMessageCount?: number;
    inlineMessageCount?: number;
    transcriptMessageCount?: number;
    imagesCount?: number;
    filesCount?: number;
  };
}

export interface CompletePreparedHandoff extends PreparedHandoff {
  instructionText: string;
  activeWindowMarkdown: string;
  fullTranscriptMarkdown: string;
  attachments: PreparedHandoffFile[];
  metadata: HandoffMetadata;
  stats: PreparedHandoff['stats'] & {
    sourceMessageCount: number;
    inlineMessageCount: number;
    transcriptMessageCount: number;
    imagesCount: number;
    filesCount: number;
  };
}

export type HandoffOptions = HandoffLimits;

/**
 * Estimates token count for English/mixed text (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Builds a provider-independent handoff payload from a canonical ConversationSnapshot.
 *
 * Rules:
 * - .ctxbridge binary archives are NEVER attached or sent to target providers.
 * - If conversation fits inline or strategy is FULL: full conversation is in promptText, no transcript.md attached.
 * - If conversation exceeds active window: active window is inline, and transcript.md is attached.
 * - Never claims "complete transcript attached" unless transcript.md is actually in attachments.
 * - Reconstructs original media/file bytes from blobs (PNG, JPEG, PDF, TXT, etc.).
 * - Attaches at most the target's per-message file limit (transcript.md included), newest files
 *   first; the text names every file and marks the ones that are not attached.
 * - Exposes distinct sourceMessageCount, inlineMessageCount, and transcriptMessageCount.
 */
export function buildHandoff(
  snapshot: ConversationSnapshot,
  blobs: Map<string, StoredBlob>,
  targetPlatform: string,
  limits: HandoffLimits = {}
): CompletePreparedHandoff {
  const sorted = ensureChronologicalOrder(snapshot);
  const sourceMessageCount = sorted.messages.length;
  const transcriptMessageCount = sorted.messages.length;
  const includeMedia = limits.includeMediaFiles !== false;

  // 1. File names first: the text refers to files by the names they are attached under.
  const plan = planAttachments(sorted.messages, blobs, ['transcript.md'], {
    acceptsAudioVideo: platformInfo(targetPlatform)?.acceptsAudioVideo === true,
  });
  const sizingRefs: AttachmentRefs = { names: plan.names };

  // 2. Determine active window
  const maxActiveTokens = limits.maxActivePromptTokens || 3500;
  const maxActiveChars = limits.maxActivePromptChars || maxActiveTokens * 4;

  const reversed = [...sorted.messages].reverse();
  const selectedRecentMessages: Message[] = [];
  let currentChars = 0;

  for (const msg of reversed) {
    const rendered = renderMessage(msg, blobs, sizingRefs);
    if (
      limits.strategy !== 'FULL' &&
      currentChars + rendered.length > maxActiveChars &&
      selectedRecentMessages.length > 0
    ) {
      break;
    }
    selectedRecentMessages.unshift(msg);
    currentChars += rendered.length;
  }

  const inlineMessageCount = selectedRecentMessages.length;
  const renderWindow = (refs: AttachmentRefs) =>
    selectedRecentMessages.map((msg) => renderMessage(msg, blobs, refs)).join('\n\n');

  // The newest message is always taken, even when it alone exceeds the budget; inlining it in
  // full can overflow the target composer. Keep its head and tail inline and rely on the attached
  // transcript for the middle.
  const inlineTruncated = limits.strategy !== 'FULL' && renderWindow(sizingRefs).length > maxActiveChars;

  const hasAttachedTranscript =
    limits.strategy === 'RECENT_PLUS_ARCHIVE' ||
    (limits.strategy !== 'FULL' && (inlineMessageCount < sourceMessageCount || inlineTruncated));
  const strategy: HandoffStrategyType = hasAttachedTranscript
    ? 'RECENT_PLUS_ARCHIVE'
    : 'FULL';

  // 3. Which files go along: the target's per-message limit counts transcript.md too.
  const fileLimit = resolveFileLimit(limits.maxFiles, targetPlatform);
  const sendable = includeMedia ? plan.entries.filter((e) => e.sendable) : [];
  const slots =
    fileLimit === undefined ? sendable.length : Math.max(0, fileLimit - (hasAttachedTranscript ? 1 : 0));
  const toAttach = sendable.slice(0, slots);
  const overLimit = sendable.slice(slots);
  const refs: AttachmentRefs = { names: plan.names, attached: new Set(toAttach.map((e) => e.sha256)) };

  let activeWindowMarkdown = renderWindow(refs);
  if (inlineTruncated && activeWindowMarkdown.length > maxActiveChars) {
    const headLen = Math.floor(maxActiveChars * 0.6);
    const tailLen = Math.max(0, maxActiveChars - headLen);
    const omitted = activeWindowMarkdown.length - headLen - tailLen;
    activeWindowMarkdown =
      `${activeWindowMarkdown.slice(0, headLen)}\n\n` +
      `...[${omitted} characters omitted here; the complete text is in transcript.md]...\n\n` +
      activeWindowMarkdown.slice(activeWindowMarkdown.length - tailLen);
  }

  // Complete deterministic Markdown transcript, with the same file names and markers.
  const fullTranscriptMarkdown = renderTranscript(sorted, { blobMap: blobs, attachmentRefs: refs });
  const transcriptBytes = new TextEncoder().encode(fullTranscriptMarkdown);

  // 4. Instruction text
  const sourceName = formatPlatformDisplayName(sorted.sourcePlatform);
  const instructionText = `You are continuing an existing conversation imported from ${sourceName}.

Treat the supplied transcript and attachments as prior conversation context, not as a new user request.
Do not summarize the history unless asked.

Note: Only user-visible conversation content was transferred. Internal provider data (such as system instructions or hidden reasoning) was not captured.`;

  // 5. Generate composed promptText
  const promptText = generateBootstrapPrompt({
    sourcePlatform: sorted.sourcePlatform,
    targetPlatform,
    conversationTitle: sorted.title,
    sourceMessageCount,
    inlineMessageCount,
    transcriptMessageCount,
    hasAttachedTranscript,
    strategy,
    recentMessagesText: activeWindowMarkdown,
  });

  // 6. Prepare outgoing attachments
  const attachments: PreparedHandoffFile[] = [];

  // If transcript is attached, include transcript.md
  if (hasAttachedTranscript) {
    attachments.push({
      filename: 'transcript.md',
      data: transcriptBytes,
      mimeType: 'text/markdown',
    });
  }

  // Original files and images, newest first. .ctxbridge archives are never sendable.
  let imagesCount = 0;
  let filesCount = 0;
  for (const entry of toAttach) {
    attachments.push({ filename: entry.filename, data: entry.data, mimeType: entry.mimeType });
    if (entry.kind === 'image') {
      imagesCount++;
    } else {
      filesCount++;
    }
  }

  const estimatedTokens = estimateTokens(promptText);
  const unsupported = includeMedia ? plan.entries.filter((e) => !e.sendable && !e.archive) : [];
  const archives = includeMedia ? plan.entries.filter((e) => e.archive) : [];

  const metadata: HandoffMetadata = {
    sourcePlatform: sorted.sourcePlatform,
    targetPlatform,
    conversationTitle: sorted.title || 'Untitled Conversation',
    sourceMessageCount,
    inlineMessageCount,
    transcriptMessageCount,
    imagesCount,
    filesCount,
    hasAttachedTranscript,
    estimatedTokens,
    ...(overLimit.length > 0 ? { filesOverLimit: overLimit.map((e) => e.filename), fileLimit } : {}),
    ...(unsupported.length > 0 ? { unsupportedFiles: unsupported.map((e) => e.filename) } : {}),
    ...(archives.length > 0 ? { archiveFiles: archives.map((e) => e.filename) } : {}),
  };

  return {
    targetPlatform,
    strategy,
    instructionText,
    activeWindowMarkdown,
    fullTranscriptMarkdown,
    promptText,
    files: attachments,
    attachments,
    metadata,
    stats: {
      totalMessages: sourceMessageCount,
      activePromptMessages: inlineMessageCount,
      attachedFilesCount: attachments.length,
      estimatedTokens,
      isTruncatedToRecent: hasAttachedTranscript,
      sourceMessageCount,
      inlineMessageCount,
      transcriptMessageCount,
      imagesCount,
      filesCount,
    },
  };
}

/** Explicit limit, else the target platform's per-message limit; undefined means no limit. */
function resolveFileLimit(maxFiles: number | undefined, targetPlatform: string): number | undefined {
  if (typeof maxFiles === 'number' && Number.isFinite(maxFiles)) return Math.max(0, Math.floor(maxFiles));
  return platformInfo(targetPlatform)?.maxFilesPerMessage;
}

/**
 * Prepares handoff material according to chosen strategy and target capabilities.
 * Backward-compatible alias for buildHandoff.
 */
export function prepareHandoff(
  snapshot: ConversationSnapshot,
  blobs: Map<string, StoredBlob>,
  targetPlatform: string,
  options: HandoffOptions = {}
): CompletePreparedHandoff {
  return buildHandoff(snapshot, blobs, targetPlatform, options);
}
