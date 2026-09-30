/**
 * ContextBridge Archive Reader (v1)
 */

import { decode } from 'cborg';
import { ConversationSnapshot, StoredBlob } from '../model/canonical';
import { validateConversationSnapshot, BOUNDS } from '../model/validation';
import { bufferToHex, verifySha256 } from '../hashing/sha256';
import {
  CTXBRIDGE_MAGIC,
  CTXBRIDGE_VERSION,
  FLAGS,
  RECORD_TAGS,
  ArchiveManifest,
  readUint16BE,
  readUint32BE,
  bytesToTag,
  matchesMagic,
} from './format';
import { decompressDeflateRaw } from '../compression/compressor';
import { decryptPayloadStream, EncryptionParams } from '../crypto/encryption';
import {
  ArchiveCorruptError,
  UnsupportedArchiveVersionError,
  WrongPasswordError,
  SecurityBoundsExceededError,
} from '../errors/errors';

export interface ArchiveReaderOptions {
  password?: string;
  verifyBlobHashes?: boolean; // Defaults to true
}

export interface ReadArchiveResult {
  manifest?: ArchiveManifest;
  snapshot: ConversationSnapshot;
  blobs: Map<string, StoredBlob>;
}

export interface ArchiveHeaderInfo {
  version: number;
  isEncrypted: boolean;
  isCompressed: boolean;
}

/**
 * Inspects archive header without decrypting or decompressing.
 */
export function inspectArchiveHeader(buffer: Uint8Array): ArchiveHeaderInfo {
  if (buffer.byteLength < 12) {
    throw new ArchiveCorruptError('Buffer is too short to be a valid ContextBridge archive');
  }

  if (!matchesMagic(buffer)) {
    throw new ArchiveCorruptError('Invalid file magic: not a ContextBridge archive');
  }

  const version = readUint16BE(buffer, 8);
  if (version !== CTXBRIDGE_VERSION) {
    throw new UnsupportedArchiveVersionError(version, CTXBRIDGE_VERSION);
  }

  const flags = readUint16BE(buffer, 10);
  const isEncrypted = (flags & FLAGS.ENCRYPTED) !== 0;
  const isCompressed = (flags & FLAGS.COMPRESSED) !== 0;

  return {
    version,
    isEncrypted,
    isCompressed,
  };
}

/**
 * Parses and deserializes an uncompressed payload buffer into records.
 */
export async function parsePayloadRecords(
  payload: Uint8Array,
  verifyHashes: boolean = true
): Promise<ReadArchiveResult> {
  let offset = 0;
  let manifest: ArchiveManifest | undefined;
  let snapshot: ConversationSnapshot | undefined;
  const blobs = new Map<string, StoredBlob>();
  let reachedEof = false;

  while (offset + 8 <= payload.byteLength) {
    const tag = bytesToTag(payload, offset);
    const length = readUint32BE(payload, offset + 4);

    if (length > BOUNDS.MAX_BLOB_SIZE) {
      throw new SecurityBoundsExceededError('record length', BOUNDS.MAX_BLOB_SIZE, length);
    }

    if (offset + 8 + length > payload.byteLength) {
      throw new ArchiveCorruptError(
        `Truncated archive: record '${tag}' expects ${length} bytes, but only ${payload.byteLength - offset - 8} available`
      );
    }

    const recordData = payload.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;

    if (tag === RECORD_TAGS.META) {
      try {
        manifest = decode(recordData) as ArchiveManifest;
      } catch (err) {
        throw new ArchiveCorruptError('Failed to parse CBOR manifest record', err);
      }
    } else if (tag === RECORD_TAGS.CONV) {
      try {
        snapshot = decode(recordData) as ConversationSnapshot;
      } catch (err) {
        throw new ArchiveCorruptError('Failed to parse CBOR conversation record', err);
      }
      validateConversationSnapshot(snapshot);
    } else if (tag === RECORD_TAGS.BLOB) {
      if (recordData.byteLength < 36) {
        throw new ArchiveCorruptError('Malformed BLOB record: length less than 36 bytes');
      }

      const sha256Bytes = recordData.subarray(0, 32);
      const sha256Hex = bufferToHex(sha256Bytes);
      const metaLen = readUint32BE(recordData, 32);

      if (36 + metaLen > recordData.byteLength) {
        throw new ArchiveCorruptError('Malformed BLOB record: metaLen exceeds record data length');
      }

      const metaCbor = recordData.subarray(36, 36 + metaLen);
      let blobMetaRecord: Record<string, unknown>;
      try {
        blobMetaRecord = decode(metaCbor) as Record<string, unknown>;
      } catch (err) {
        throw new ArchiveCorruptError('Failed to decode BLOB metadata CBOR', err);
      }

      const rawData = new Uint8Array(recordData.subarray(36 + metaLen));

      if (typeof blobMetaRecord.byteSize === 'number' && rawData.byteLength !== blobMetaRecord.byteSize) {
        throw new ArchiveCorruptError(
          `Blob size mismatch: metadata declares ${blobMetaRecord.byteSize} bytes, actual is ${rawData.byteLength}`
        );
      }

      if (verifyHashes) {
        const isValid = await verifySha256(rawData, sha256Hex);
        if (!isValid) {
          throw new ArchiveCorruptError(
            `Blob integrity check failed: SHA-256 digest mismatch for blob ${sha256Hex}`
          );
        }
      }

      blobs.set(sha256Hex, {
        metadata: {
          sha256: sha256Hex,
          mimeType: String(blobMetaRecord.mimeType || 'application/octet-stream'),
          byteSize: rawData.byteLength,
          filename: blobMetaRecord.filename ? String(blobMetaRecord.filename) : undefined,
          role: blobMetaRecord.role as StoredBlob['metadata']['role'],
          captureSource: blobMetaRecord.captureSource ? String(blobMetaRecord.captureSource) : undefined,
          originalUrl: blobMetaRecord.originalUrl ? String(blobMetaRecord.originalUrl) : undefined,
        },
        data: rawData,
      });
    } else if (tag === RECORD_TAGS.EOF) {
      reachedEof = true;
      break;
    } else {
      // Forward compatibility: safely ignore unknown record tags
      console.warn(`[ContextBridge] Skipping unknown archive record tag: ${tag}`);
    }
  }

  if (!snapshot) {
    throw new ArchiveCorruptError('Archive missing conversation snapshot record');
  }

  if (!reachedEof) {
    throw new ArchiveCorruptError('Archive ended unexpectedly before EOF record');
  }

  return {
    manifest,
    snapshot,
    blobs,
  };
}

/**
 * Reads, verifies, decrypts, and unpacks a .ctxbridge archive.
 */
export async function readArchive(
  buffer: Uint8Array,
  options: ArchiveReaderOptions = {}
): Promise<ReadArchiveResult> {
  const headerInfo = inspectArchiveHeader(buffer);
  const verifyHashes = options.verifyBlobHashes !== false;

  let payload: Uint8Array;

  if (headerInfo.isEncrypted) {
    if (!options.password) {
      throw new WrongPasswordError('Password required to decrypt this archive');
    }

    // Encrypted header length is 61 bytes
    const headerLen = 61;
    if (buffer.byteLength < headerLen) {
      throw new ArchiveCorruptError('Encrypted archive buffer too small for encryption header');
    }

    const kdfAlgorithm = buffer[12] ?? 0;
    const opslimit = readUint32BE(buffer, 13);
    const memlimit = readUint32BE(buffer, 17);
    const salt = buffer.subarray(21, 37);
    const secretstreamHeader = buffer.subarray(37, 61);

    const params: EncryptionParams = {
      kdfAlgorithm,
      opslimit,
      memlimit,
      salt: new Uint8Array(salt),
      header: new Uint8Array(secretstreamHeader),
    };

    // Extract encrypted chunks
    let offset = headerLen;
    const chunks: Uint8Array[] = [];

    while (offset + 4 <= buffer.byteLength) {
      const chunkLen = readUint32BE(buffer, offset);
      offset += 4;

      if (chunkLen > BOUNDS.MAX_BLOB_SIZE) {
        throw new SecurityBoundsExceededError('encrypted chunk length', BOUNDS.MAX_BLOB_SIZE, chunkLen);
      }

      if (offset + chunkLen > buffer.byteLength) {
        throw new ArchiveCorruptError('Truncated encrypted chunk: length exceeds remaining file');
      }

      chunks.push(buffer.subarray(offset, offset + chunkLen));
      offset += chunkLen;
    }

    if (chunks.length === 0) {
      throw new ArchiveCorruptError('Encrypted archive contains no encrypted chunks');
    }

    // Decrypt chunks
    const decryptedChunks = await decryptPayloadStream(chunks, params, options.password);

    // Concatenate decrypted chunks
    let totalLen = 0;
    for (const c of decryptedChunks) {
      totalLen += c.byteLength;
    }
    const decryptedPayload = new Uint8Array(totalLen);
    let decOffset = 0;
    for (const c of decryptedChunks) {
      decryptedPayload.set(c, decOffset);
      decOffset += c.byteLength;
    }

    payload = decryptedPayload;
  } else {
    // Plaintext
    payload = buffer.subarray(12);
  }

  // Decompress if needed
  if (headerInfo.isCompressed) {
    payload = await decompressDeflateRaw(payload);
  }

  // Parse records
  return await parsePayloadRecords(payload, verifyHashes);
}
