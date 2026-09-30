/**
 * Compression utilities using native Web Streams (CompressionStream / DecompressionStream)
 */

import { ArchiveCorruptError, SecurityBoundsExceededError } from '../errors/errors';

/** Upper bound for an inflated payload; protects the popup against decompression bombs. */
export const MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;

const ALREADY_COMPRESSED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'application/pdf',
  'application/zip',
  'application/gzip',
  'application/x-gzip',
  'application/x-zip-compressed',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/**
 * Checks if a MIME type typically contains pre-compressed binary data.
 */
export function isAlreadyCompressed(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  return ALREADY_COMPRESSED_MIMES.has(normalized);
}

/**
 * Compresses binary data using 'deflate-raw' via CompressionStream.
 */
export async function compressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (data.byteLength === 0) {
    return new Uint8Array(0);
  }

  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    // Start writing and close
    const writePromise = writer.write(data as any).then(() => writer.close());
    const responsePromise = new Response(cs.readable).arrayBuffer();
    await writePromise;
    const arrayBuffer = await responsePromise;
    return new Uint8Array(arrayBuffer);
  }

  // Node.js fallback if CompressionStream is absent
  try {
    const zlib = await import('node:zlib');
    const { promisify } = await import('node:util');
    const deflateRaw = promisify(zlib.deflateRaw);
    const buf = await deflateRaw(data);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    throw new Error(`Compression not supported in this environment: ${String(err)}`);
  }
}

/**
 * Decompresses binary data using 'deflate-raw' via DecompressionStream.
 */
export async function decompressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (data.byteLength === 0) {
    return new Uint8Array(0);
  }

  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const writePromise = writer.write(data as any).then(() => writer.close());
      writePromise.catch(() => {}); // a write failure also errors the readable side below
      // Read incrementally so an oversized inflation is stopped before it exhausts memory.
      const reader = ds.readable.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DECOMPRESSED_BYTES) {
          await reader.cancel().catch(() => {});
          throw new SecurityBoundsExceededError('decompressed payload', MAX_DECOMPRESSED_BYTES, total);
        }
        chunks.push(value);
      }
      await writePromise;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    } catch (err) {
      if (err instanceof SecurityBoundsExceededError) throw err;
      throw new ArchiveCorruptError('Decompression failed: corrupted compressed stream', err);
    }
  }

  // Node.js fallback
  try {
    const zlib = await import('node:zlib');
    const { promisify } = await import('node:util');
    const inflateRaw = promisify(zlib.inflateRaw);
    const buf = await inflateRaw(data);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    throw new ArchiveCorruptError('Decompression failed via zlib', err);
  }
}
