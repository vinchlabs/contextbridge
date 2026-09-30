/**
 * Replaces image/file parts whose blobSha256 is still a capture-time placeholder (page URL,
 * chatgpt-file:// reference, ...) with explicit, renderable "not included" markers.
 *
 * Without this, a snapshot with unresolved media fails archive validation ("must have 64-char
 * hex blobSha256") and handoff prompts leak raw provider URLs. The marker keeps the fact that an
 * attachment existed (name + type) without pretending its bytes were captured.
 */

import type { ContentPart, Message, UnknownContentPart } from './canonical';

const HEX64 = /^[0-9a-f]{64}$/;

export type UnresolvedMediaReason = 'excluded_by_user' | 'not_captured';

export function isResolvedBlobRef(sha: string, hasBlob: (sha: string) => boolean): boolean {
  return HEX64.test(sha) && hasBlob(sha);
}

export function markUnresolvedMediaParts(
  messages: Message[],
  hasBlob: (sha: string) => boolean,
  reason: UnresolvedMediaReason
): number {
  let replaced = 0;
  for (const msg of messages) {
    msg.content = msg.content.map((part): ContentPart => {
      if ((part.type !== 'image' && part.type !== 'file') || isResolvedBlobRef(part.blobSha256, hasBlob)) {
        return part;
      }
      replaced++;
      const name = part.type === 'file' ? part.filename : part.altText;
      const why =
        reason === 'excluded_by_user'
          ? 'attachments were excluded from this export'
          : 'its bytes could not be captured';
      const marker: UnknownContentPart = {
        type: 'unknown',
        platformType: `${reason === 'excluded_by_user' ? 'omitted' : 'uncaptured'}-${part.type}`,
        rawText: `[${part.type === 'image' ? 'Image' : 'File'} not included${name ? `: ${name}` : ''} (${why})]`,
        metadata: {
          reason,
          originalType: part.type,
          ...(name ? { filename: name } : {}),
          ...(part.mimeType ? { mimeType: part.mimeType } : {}),
        },
      };
      return marker;
    });
  }
  return replaced;
}
