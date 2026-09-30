/**
 * Resolves media and attachments referenced by ChatGPT messages into content-addressed blobs
 */

import { Message, StoredBlob } from '../../core/model/canonical';
import { BlobStore } from '../../core/hashing/sha256';
import { ExtractedMediaReference } from './extractor';
import { CaptureProgress } from '../adapter';
import { CaptureIncompleteError } from '../../core/errors/errors';
import { baseMime, isImageMime, sniffImageMime, withImageExtension } from '../../core/model/attachments';
import {
  describeMediaSource,
  fetchMediaViaBackground,
  MediaReadError,
  MediaTooLargeError,
  MEDIA_MAX_BYTES,
} from '../../utils/media-fetch';
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
  // Every unreadable upload is named at once, so one "Skip missing files" covers them all.
  const missingUploads: Array<{ name: string; url: string; reason: string }> = [];

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

      // Pictures carry no type or an image type; videos, audio and files carry theirs.
      const picture = !ref.mimeType || isImageMime(ref.mimeType);
      const { data, mimeType } = await fetchMediaBinary(url, { picture });
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
          missingUploads.push({
            name: ref.filename || ref.altText?.slice(0, 80) || 'an uploaded image',
            url,
            reason: `${describeMediaSource(url)} | ${err instanceof MediaReadError ? err.message : errorLine(err, 300)}`,
          });
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

  if (missingUploads.length > 0 && !signal?.aborted) {
    const first = missingUploads[0]!;
    // How each read failed (origins only, no paths or tokens), for the technical message.
    const reasons = missingUploads.map((m) => `[${m.name}: ${m.reason}]`).join(' ');
    throw new CaptureIncompleteError(
      `Failed to capture user upload file bytes for ${missingUploads.map((m) => m.name).join(', ')} ${reasons}`,
      {
        terminationReason: 'unresolved_user_attachment',
        failedUrl: first.url,
        filename: first.name,
        missingFiles: missingUploads.map((m) => m.name),
      }
    );
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
 * Fetches binary data from standard HTTP URLs, blob: URLs, or data: URLs. When every way fails,
 * throws a MediaReadError whose trail says how each one failed.
 * `picture`: the URL is a picture, so its pixels are an acceptable last resort.
 */
export async function fetchMediaBinary(
  url: string,
  opts: { picture?: boolean } = {}
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

  // 3. Only real URLs can be fetched. Placeholders (gemini-file://, claude-file://) name a file
  //    the page shows without giving a way to read it.
  if (!/^(https?:|blob:)/i.test(url)) {
    throw new Error(`No download URL for this file (${url.split(':')[0]})`);
  }

  // 4. HTTP / HTTPS / blob: URLs, directly from the content script.
  const trail: string[] = [];
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
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) throw new MediaTooLargeError(declared);
      const mimeType = response.headers.get('content-type') || inferMimeFromUrl(url);
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MEDIA_MAX_BYTES) throw new MediaTooLargeError(arrayBuffer.byteLength);
      return {
        // In Firefox MV3 content scripts the response buffer belongs to the page realm.
        data: ownBytes(arrayBuffer),
        mimeType,
      };
    }
    trail.push(`direct: HTTP ${response.status}`);
  } catch (fetchErr) {
    if (fetchErr instanceof MediaTooLargeError) throw fetchErr;
    trail.push(`direct: ${errorLine(fetchErr)}`);
  }

  // A picture from the page's own blob: URL is same-origin, so its pixels are readable here
  // (Firefox lets neither this script nor, under Gemini's CSP, the page fetch that URL).
  const ownBlobPicture = url.startsWith('blob:') && opts.picture === true;
  if (ownBlobPicture) {
    const shown = readShownPicture(url, trail);
    if (shown) return shown;
  }

  // 5. Cross-origin media without CORS headers (googleusercontent.com, oaiusercontent.com) and
  //    the page's own blob: URLs: the background reads them on the extension's host permissions,
  //    or through the page itself (Gemini's pictures need the page's Google session, and only
  //    the page may read its blob: URLs).
  if (/^(https:|blob:)/i.test(url)) {
    try {
      const viaBackground = await fetchMediaViaBackground(url, opts.picture === true);
      if (viaBackground) return viaBackground;
      trail.push('background: no extension runtime');
    } catch (bgErr) {
      if (bgErr instanceof MediaTooLargeError) throw bgErr;
      trail.push(`background: ${errorLine(bgErr, 500)}`);
    }
  }

  // 6. A picture the page has already drawn, read back through a canvas (fails when a
  //    cross-origin picture taints the canvas).
  if (!ownBlobPicture) {
    const shown = readShownPicture(url, trail);
    if (shown) return shown;
  }

  throw new MediaReadError(trail);
}

/** The pixels of a picture the page shows at `url`, as PNG; null (and a trail entry) otherwise. */
function readShownPicture(url: string, trail: string[]): { data: Uint8Array; mimeType: string } | null {
  if (typeof document === 'undefined') return null;
  const imgEl = Array.from(document.querySelectorAll('img')).find(
    (img) => img.currentSrc === url || img.getAttribute('src') === url
  );
  if (!imgEl) {
    trail.push('canvas: picture not on the page');
    return null;
  }
  if (!imgEl.complete || imgEl.naturalWidth === 0) {
    trail.push('canvas: picture not loaded');
    return null;
  }
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
        if (bytes.length > MEDIA_MAX_BYTES) throw new MediaTooLargeError(bytes.length);
        if (bytes.length > 0) return { data: bytes, mimeType: 'image/png' };
      }
    }
    trail.push('canvas: no image data');
  } catch (canvasErr) {
    if (canvasErr instanceof MediaTooLargeError) throw canvasErr;
    // Tainted by a cross-origin picture, or not allowed.
    trail.push(`canvas: ${errorLine(canvasErr)}`);
  }
  return null;
}

/** One line for an error: name and message, addresses cut to their origin, at most `max` long. */
function errorLine(err: unknown, max = 160): string {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === 'string' && e.name !== 'Error' ? `${e.name}: ` : '';
  return `${name}${String(e?.message ?? err)}`
    .replace(/\b(?:blob:)?https?:\/\/[^\s"'<>]+/gi, (address) => describeMediaSource(address))
    .replace(/\s+/g, ' ')
    .slice(0, max);
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
