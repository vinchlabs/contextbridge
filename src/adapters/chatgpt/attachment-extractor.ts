/**
 * Resolves media and attachments referenced by ChatGPT messages into content-addressed blobs
 */

import { Message, StoredBlob } from '../../core/model/canonical';
import { BlobStore } from '../../core/hashing/sha256';
import { ExtractedMediaReference } from './extractor';
import { CaptureProgress } from '../adapter';
import { CaptureIncompleteError } from '../../core/errors/errors';
import { baseMime, isImageMime, sniffImageMime, withImageExtension } from '../../core/model/attachments';
import { ownBytes } from '../../utils/wire-bytes';

export async function resolveChatGPTMedia(
  messages: Message[],
  mediaRefs: ExtractedMediaReference[],
  blobStore: BlobStore,
  onProgress?: (progress: CaptureProgress) => void,
  signal?: AbortSignal,
  /** The user chose to copy anyway: an unreadable upload stays a placeholder ("not included" marker). */
  allowMissingUserUploads = false
): Promise<Map<string, StoredBlob>> {
  const urlToShaMap = new Map<string, string>();
  let processed = 0;

  for (const ref of mediaRefs) {
    if (signal?.aborted) break;

    const url = ref.url;
    if (urlToShaMap.has(url)) {
      continue;
    }

    try {
      onProgress?.({
        phase: 'resolving-media',
        messagesFound: messages.length,
        imagesFound: blobStore.count,
        filesFound: 0,
        currentOperation: `Resolving media item ${processed + 1} of ${mediaRefs.length}...`,
      });

      const { data, mimeType } = await fetchMediaBinary(url);
      const { mimeType: finalMime, filename } = describeFetchedMedia(data, mimeType, ref);
      const meta = await blobStore.put(data, {
        mimeType: finalMime,
        filename,
        role: ref.role,
        captureSource: url,
        originalUrl: url.startsWith('http') ? url : undefined,
      });

      urlToShaMap.set(url, meta.sha256);
    } catch (err) {
      console.warn(`[ContextBridge] Failed to fetch media URL directly (${url}):`, err);

      // Never create fake fallback text blobs for user uploads
      if (ref.role === 'user-upload') {
        if (ref.fallbackData) {
          const meta = await blobStore.put(ref.fallbackData, {
            mimeType: ref.mimeType || inferMimeFromUrl(url),
            filename: ref.filename || 'attachment.bin',
            role: ref.role,
            captureSource: url,
            originalUrl: url.startsWith('http') ? url : undefined,
          });
          urlToShaMap.set(url, meta.sha256);
        } else if (!allowMissingUserUploads) {
          throw new CaptureIncompleteError(
            `Failed to capture user upload file bytes for ${ref.filename || url}`,
            {
              terminationReason: 'unresolved_user_attachment',
              failedUrl: url,
              filename: ref.filename,
              missingFiles: [ref.filename || 'an uploaded image'],
            }
          );
        }
      } else {
        // Non-user uploads (e.g. system or assistant assets): preserve fallback if provided
        try {
          if (ref.fallbackData) {
            const meta = await blobStore.put(ref.fallbackData, {
              mimeType: ref.mimeType || inferMimeFromUrl(url),
              filename: ref.filename || 'attachment.bin',
              role: ref.role,
              captureSource: url,
              originalUrl: url.startsWith('http') ? url : undefined,
            });
            urlToShaMap.set(url, meta.sha256);
          }
        } catch (putErr) {
          console.warn(`[ContextBridge] Could not create fallback attachment record for ${url}:`, putErr);
        }
      }
    }

    processed++;
  }

  // Update messages: replace placeholder URLs with resolved SHA-256 hashes
  for (const msg of messages) {
    for (const part of msg.content) {
      if (part.type === 'image' && urlToShaMap.has(part.blobSha256)) {
        const sha = urlToShaMap.get(part.blobSha256)!;
        part.blobSha256 = sha;
        const b = blobStore.get(sha);
        // The stored type comes from the bytes; a guess made from the alt text loses.
        if (b && (!part.mimeType || isImageMime(b.metadata.mimeType))) {
          part.mimeType = b.metadata.mimeType;
        }
      } else if (part.type === 'file' && urlToShaMap.has(part.blobSha256)) {
        const sha = urlToShaMap.get(part.blobSha256)!;
        part.blobSha256 = sha;
        const b = blobStore.get(sha);
        if (b) {
          if (!part.byteSize) part.byteSize = b.metadata.byteSize;
          if (!part.mimeType) part.mimeType = b.metadata.mimeType;
        }
      }
    }
  }

  return blobStore.getAll();
}

/**
 * Type and name for fetched media. The extractor guesses "image/png" and a ".png" name from alt
 * text; the bytes (or an image type the server sent) say what the picture really is.
 */
export function describeFetchedMedia(
  data: Uint8Array,
  servedMime: string,
  ref: Pick<ExtractedMediaReference, 'mimeType' | 'filename'>
): { mimeType: string; filename?: string } {
  const served = baseMime(servedMime);
  const declared = baseMime(ref.mimeType);
  const sniffed = sniffImageMime(data);
  let mimeType: string;
  if (sniffed) {
    mimeType = sniffed;
  } else if (isImageMime(declared) && isImageMime(served)) {
    mimeType = served;
  } else {
    mimeType = ref.mimeType || servedMime || 'application/octet-stream';
  }
  const filename = ref.filename && sniffed ? withImageExtension(ref.filename, sniffed) : ref.filename;
  return { mimeType, filename };
}

/**
 * Fetches binary data from standard HTTP URLs, blob: URLs, or data: URLs.
 */
export async function fetchMediaBinary(
  url: string
): Promise<{ data: Uint8Array; mimeType: string }> {
  // 1. Handle synthetic ChatGPT internal file references (skip network fetch)
  if (url.startsWith('chatgpt-file://')) {
    throw new Error(`ChatGPT file reference without direct download URL (${url})`);
  }

  // 2. Handle data: URLs
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      throw new Error('Malformed data: URL');
    }
    const metaPart = url.slice(5, commaIndex);
    const dataPart = url.slice(commaIndex + 1);

    const isBase64 = metaPart.includes(';base64');
    const mimeType = metaPart.split(';')[0] || 'application/octet-stream';

    if (isBase64) {
      const binaryString = atob(dataPart);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return { data: bytes, mimeType };
    } else {
      const decoded = decodeURIComponent(dataPart);
      return { data: ownBytes(new TextEncoder().encode(decoded)), mimeType };
    }
  }

  // 2. Handle HTTP / HTTPS / blob: URLs
  try {
    // Session cookies only for the page's own origin: a credentialed cross-origin request fails
    // CORS against CDNs that answer `Access-Control-Allow-Origin: *` (signed URLs need no cookies).
    let sameOrigin = true;
    try {
      if (typeof location !== 'undefined' && /^https?:/i.test(url)) {
        sameOrigin = new URL(url, location.href).origin === location.origin;
      }
    } catch {
      sameOrigin = true;
    }
    const response = await fetch(url, {
      credentials: sameOrigin ? 'include' : 'omit',
    });

    if (response.ok) {
      const mimeType = response.headers.get('content-type') || inferMimeFromUrl(url);
      const arrayBuffer = await response.arrayBuffer();
      return {
        // In Firefox MV3 content scripts the response buffer belongs to the page realm.
        data: ownBytes(arrayBuffer),
        mimeType,
      };
    }
  } catch (fetchErr) {
    // If fetch failed and we are in browser with DOM, try reading rendered image from DOM via canvas
    if (typeof document !== 'undefined') {
      const imgEl = document.querySelector(`img[src="${url}"]`) as HTMLImageElement | null;
      if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = imgEl.naturalWidth;
          canvas.height = imgEl.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(imgEl, 0, 0);
            const dataUrl = canvas.toDataURL('image/png');
            const comma = dataUrl.indexOf(',');
            if (comma !== -1) {
              const bin = atob(dataUrl.slice(comma + 1));
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              return { data: bytes, mimeType: 'image/png' };
            }
          }
        } catch {
          // Canvas tainted or not allowed
        }
      }
    }
    throw fetchErr;
  }

  throw new Error(`Failed to fetch media binary from ${url}`);
}

export function inferMimeFromUrl(url: string): string {
  const clean = url.split('?')[0]?.toLowerCase() || '';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  if (clean.endsWith('.pdf')) return 'application/pdf';
  if (clean.endsWith('.csv')) return 'text/csv';
  if (clean.endsWith('.json')) return 'application/json';
  if (clean.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}
