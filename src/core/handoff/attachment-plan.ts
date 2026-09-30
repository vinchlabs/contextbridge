/**
 * Which captured files go to the target AI, in which order and under which names.
 * The same names appear in the handoff text ("[Image: name]"), on the attached files and in
 * the popup's "Save files", so the model and the user can match them up.
 */

import type { Message, StoredBlob } from '../model/canonical';
import {
  attachmentFileName,
  baseMime,
  isAudioVideo,
  isImageMime,
  isSendableDocument,
  isSendableImageMime,
  mimeForFilename,
  sniffImageMime,
  uniqueName,
  withImageExtension,
} from '../model/attachments';

export interface PlannedAttachment {
  sha256: string;
  /** Unique within the handoff (transcript.md included). */
  filename: string;
  /** Best known type: sniffed for images, derived from the name for octet-stream blobs. */
  mimeType: string;
  kind: 'image' | 'file';
  /** The supported chat sites read this type. */
  sendable: boolean;
  /** A ContextBridge archive: never uploaded anywhere. */
  archive: boolean;
  /** The stored bytes (same reference as the blob, so cached base64 can be reused). */
  data: Uint8Array;
}

export interface AttachmentPlan {
  /** Every blob, newest reference first, then blobs no message refers to. */
  entries: PlannedAttachment[];
  /** blob sha256 -> file name. */
  names: Map<string, string>;
}

/** Newest message first; the first time a blob shows up wins. */
function blobsByRecency(messages: Message[], blobs: Map<string, StoredBlob>): { order: string[]; partNames: Map<string, string> } {
  const order: string[] = [];
  const seen = new Set<string>();
  const partNames = new Map<string, string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]?.content ?? []) {
      if (part.type !== 'image' && part.type !== 'file') continue;
      const sha = part.blobSha256;
      if (!blobs.has(sha)) continue;
      if (part.type === 'file' && part.filename && !partNames.has(sha)) partNames.set(sha, part.filename);
      if (seen.has(sha)) continue;
      seen.add(sha);
      order.push(sha);
    }
  }
  for (const sha of blobs.keys()) {
    if (!seen.has(sha)) {
      seen.add(sha);
      order.push(sha);
    }
  }
  return { order, partNames };
}

export interface PlanOptions {
  /** The target reads audio and video (Gemini). Default false. */
  acceptsAudioVideo?: boolean;
}

/**
 * @param reservedNames names already used by the handoff itself (transcript.md).
 */
export function planAttachments(
  messages: Message[],
  blobs: Map<string, StoredBlob>,
  reservedNames: string[] = [],
  opts: PlanOptions = {}
): AttachmentPlan {
  const taken = new Set(reservedNames.map((n) => n.toLowerCase()));
  const { order, partNames } = blobsByRecency(messages, blobs);
  const entries: PlannedAttachment[] = [];
  const names = new Map<string, string>();

  for (const sha of order) {
    const blob = blobs.get(sha);
    if (!blob) continue;
    const rawName = blob.metadata.filename || partNames.get(sha) || '';
    const declared = baseMime(blob.metadata.mimeType);
    const archive = rawName.toLowerCase().endsWith('.ctxbridge') || declared === 'application/x-contextbridge';

    let mimeType: string;
    const sniffed = archive ? undefined : sniffImageMime(blob.data);
    if (sniffed) {
      mimeType = sniffed;
    } else if (declared && declared !== 'application/octet-stream') {
      mimeType = declared;
    } else {
      mimeType = mimeForFilename(rawName) || declared || 'application/octet-stream';
    }

    const image = !archive && isImageMime(mimeType);
    let filename = attachmentFileName(rawName, sha, mimeType);
    if (image) filename = withImageExtension(filename, mimeType);
    filename = uniqueName(filename, taken);

    const sendable =
      !archive &&
      (image
        ? isSendableImageMime(mimeType)
        : isSendableDocument(mimeType, filename) || (opts.acceptsAudioVideo === true && isAudioVideo(mimeType, filename)));
    names.set(sha, filename);
    entries.push({ sha256: sha, filename, mimeType, kind: image ? 'image' : 'file', sendable, archive, data: blob.data });
  }

  return { entries, names };
}
