/**
 * The handoff as it travels to a target tab: only what the composer importer needs (prompt,
 * files, counts), with file bytes as base64. The large preview-only fields of the prepared
 * handoff (full transcript, active window) are already inside promptText/transcript.md.
 */

import type { StoredBlob, ConversationSnapshot } from '../model/canonical';
import {
  buildHandoff,
  type HandoffLimits,
  type HandoffMetadata,
  type HandoffStrategyType,
  type PreparedHandoff,
  type PreparedHandoffFile,
} from './strategies';
import { bytesToBase64, fromWireBytes, type WireBytes } from '../../utils/wire-bytes';

export interface WireHandoffFile {
  filename: string;
  mimeType: string;
  data: WireBytes;
}

export interface WireHandoff {
  wire: 1;
  targetPlatform: string;
  strategy: HandoffStrategyType;
  promptText: string;
  files: WireHandoffFile[];
  metadata: HandoffMetadata;
}

/**
 * @param base64ByBytes optional cache (from the tray) so blobs that are already base64 are not
 *   encoded a second time.
 */
export function buildWireHandoff(
  snapshot: ConversationSnapshot,
  blobs: Map<string, StoredBlob>,
  targetPlatform: string,
  limits: HandoffLimits = {},
  base64ByBytes?: Map<Uint8Array, string>
): WireHandoff {
  const prepared = buildHandoff(snapshot, blobs, targetPlatform, limits);
  return {
    wire: 1,
    targetPlatform: prepared.targetPlatform,
    strategy: prepared.strategy,
    promptText: prepared.promptText,
    files: prepared.files.map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      data: { b64: base64ByBytes?.get(f.data) ?? bytesToBase64(f.data) },
    })),
    metadata: prepared.metadata,
  };
}

/**
 * Content-script side: turns a received handoff back into the PreparedHandoff the importers
 * take. Also accepts an already prepared handoff (bytes as arrays or typed arrays).
 */
export function fromWireHandoff(value: unknown): PreparedHandoff {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<WireHandoff> & Partial<PreparedHandoff>;
  const rawFiles: unknown[] = Array.isArray(v.files) ? v.files : [];
  const files: PreparedHandoffFile[] = rawFiles.map((raw) => {
    const f = (raw && typeof raw === 'object' ? raw : {}) as { filename?: unknown; mimeType?: unknown; data?: unknown };
    return {
      filename: typeof f.filename === 'string' && f.filename ? f.filename : 'file',
      mimeType: typeof f.mimeType === 'string' && f.mimeType ? f.mimeType : 'application/octet-stream',
      data: fromWireBytes(f.data),
    };
  });
  const promptText = typeof v.promptText === 'string' ? v.promptText : '';
  const metadata = v.metadata;
  const total = metadata?.sourceMessageCount ?? v.stats?.totalMessages ?? 0;
  return {
    targetPlatform: typeof v.targetPlatform === 'string' ? v.targetPlatform : '',
    strategy: v.strategy === 'RECENT_PLUS_ARCHIVE' ? 'RECENT_PLUS_ARCHIVE' : 'FULL',
    promptText,
    files,
    attachments: files,
    metadata,
    stats: v.stats ?? {
      totalMessages: total,
      activePromptMessages: metadata?.inlineMessageCount ?? total,
      attachedFilesCount: files.length,
      estimatedTokens: metadata?.estimatedTokens ?? Math.ceil(promptText.length / 4),
      isTruncatedToRecent: metadata?.hasAttachedTranscript ?? false,
    },
  };
}
