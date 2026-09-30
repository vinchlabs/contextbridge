/**
 * ContextBridge Archive Writer (v1)
 */

import { encode } from 'cborg';
import { ConversationSnapshot, StoredBlob } from '../model/canonical';
import { validateConversationSnapshot } from '../model/validation';
import { hexToBuffer } from '../hashing/sha256';
import {
  CTXBRIDGE_MAGIC,
  CTXBRIDGE_VERSION,
  FLAGS,
  RECORD_TAGS,
  ArchiveManifest,
  writeUint16BE,
  writeUint32BE,
  tagToBytes,
} from './format';
import { compressDeflateRaw } from '../compression/compressor';
import { encryptPayloadStream } from '../crypto/encryption';

export interface ArchiveWriterOptions {
  compress?: boolean;
  password?: string;
  customOpslimit?: number;
  customMemlimit?: number;
}

/**
 * Builds a framed record: [4-byte Tag][4-byte Length BE][Payload...]
 */
export function buildRecord(tag: string, payload: Uint8Array): Uint8Array {
  const record = new Uint8Array(8 + payload.byteLength);
  const tagBytes = tagToBytes(tag);
  record.set(tagBytes, 0);
  writeUint32BE(payload.byteLength, record, 4);
  record.set(payload, 8);
  return record;
}

/**
 * Builds a BLOB record payload:
 * [32-byte SHA256][4-byte CBOR meta length BE][CBOR meta bytes][Raw data bytes]
 */
export function buildBlobPayload(blob: StoredBlob): Uint8Array {
  const sha256Bytes = hexToBuffer(blob.metadata.sha256);
  if (sha256Bytes.byteLength !== 32) {
    throw new Error(`Invalid sha256 byte length: ${sha256Bytes.byteLength}`);
  }

  const metaCbor = encode({
    mimeType: blob.metadata.mimeType,
    filename: blob.metadata.filename,
    byteSize: blob.metadata.byteSize,
    role: blob.metadata.role,
    captureSource: blob.metadata.captureSource,
    originalUrl: blob.metadata.originalUrl,
  });

  const totalPayloadLen = 32 + 4 + metaCbor.byteLength + blob.data.byteLength;
  const payload = new Uint8Array(totalPayloadLen);

  payload.set(sha256Bytes, 0);
  writeUint32BE(metaCbor.byteLength, payload, 32);
  payload.set(metaCbor, 36);
  payload.set(blob.data, 36 + metaCbor.byteLength);

  return payload;
}

/**
 * Serializes conversation snapshot and blobs into an uncompressed payload buffer.
 */
export function serializePayload(
  snapshot: ConversationSnapshot,
  blobs: Map<string, StoredBlob>
): Uint8Array {
  validateConversationSnapshot(snapshot);

  let totalBlobBytes = 0;
  for (const b of blobs.values()) {
    totalBlobBytes += b.data.byteLength;
  }

  const manifest: ArchiveManifest = {
    schemaVersion: snapshot.schemaVersion,
    generator: 'ContextBridge v1.0.0',
    createdAt: snapshot.capturedAt,
    sourcePlatform: snapshot.sourcePlatform,
    title: snapshot.title,
    messageCount: snapshot.messages.length,
    attachmentCount: blobs.size,
    totalBlobBytes,
  };

  const records: Uint8Array[] = [];

  // 1. META record
  const metaCbor = encode(manifest);
  records.push(buildRecord(RECORD_TAGS.META, metaCbor));

  // 2. CONV record
  const convCbor = encode(snapshot);
  records.push(buildRecord(RECORD_TAGS.CONV, convCbor));

  // 3. BLOB records
  for (const blob of blobs.values()) {
    const blobPayload = buildBlobPayload(blob);
    records.push(buildRecord(RECORD_TAGS.BLOB, blobPayload));
  }

  // 4. EOF record
  records.push(buildRecord(RECORD_TAGS.EOF, new Uint8Array(0)));

  // Calculate total length
  let totalLength = 0;
  for (const r of records) {
    totalLength += r.byteLength;
  }

  // Concatenate
  const payloadBuffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const r of records) {
    payloadBuffer.set(r, offset);
    offset += r.byteLength;
  }

  return payloadBuffer;
}

/**
 * Builds the complete .ctxbridge archive binary file.
 */
export async function buildArchive(
  snapshot: ConversationSnapshot,
  blobs: Map<string, StoredBlob>,
  options: ArchiveWriterOptions = {}
): Promise<Uint8Array> {
  const shouldCompress = options.compress !== false;
  const isEncrypted = Boolean(options.password);

  // 1. Serialize payload
  let payload = serializePayload(snapshot, blobs);

  // 2. Flags
  let flags = FLAGS.NONE;

  // 3. Compression
  if (shouldCompress) {
    payload = await compressDeflateRaw(payload);
    flags |= FLAGS.COMPRESSED;
  }

  // 4. Encryption
  if (isEncrypted) {
    flags |= FLAGS.ENCRYPTED;

    const encrypted = await encryptPayloadStream(
      [payload],
      options.password!,
      options.customOpslimit,
      options.customMemlimit
    );

    // Header layout for encrypted:
    // Magic: 8 bytes (0..7)
    // Version: 2 bytes (8..9)
    // Flags: 2 bytes (10..11)
    // KDF Alg: 1 byte (12)
    // Opslimit: 4 bytes (13..16)
    // Memlimit: 4 bytes (17..20)
    // Salt: 16 bytes (21..36)
    // SecretStream Header: 24 bytes (37..60)
    // Total header = 8 + 2 + 2 + 1 + 4 + 4 + 16 + 24 = 61 bytes
    const headerLen = 61;

    // Encrypted chunks framing:
    // Each chunk: [4-byte length BE][chunk ciphertext]
    let totalCiphertextLen = 0;
    for (const chunk of encrypted.chunks) {
      totalCiphertextLen += 4 + chunk.byteLength;
    }

    const archive = new Uint8Array(headerLen + totalCiphertextLen);

    // Write Magic
    archive.set(CTXBRIDGE_MAGIC, 0);
    // Write Version
    writeUint16BE(CTXBRIDGE_VERSION, archive, 8);
    // Write Flags
    writeUint16BE(flags, archive, 10);
    // Write KDF Alg
    archive[12] = encrypted.params.kdfAlgorithm;
    // Write Opslimit
    writeUint32BE(encrypted.params.opslimit, archive, 13);
    // Write Memlimit
    writeUint32BE(encrypted.params.memlimit, archive, 17);
    // Write Salt (16 bytes)
    archive.set(encrypted.params.salt, 21);
    // Write SecretStream Header (24 bytes)
    archive.set(encrypted.params.header, 37);

    // Write encrypted chunks
    let offset = headerLen;
    for (const chunk of encrypted.chunks) {
      writeUint32BE(chunk.byteLength, archive, offset);
      offset += 4;
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return archive;
  }

  // Plaintext archive layout:
  // Magic: 8 bytes
  // Version: 2 bytes
  // Flags: 2 bytes
  // Total header = 12 bytes
  const headerLen = 12;
  const archive = new Uint8Array(headerLen + payload.byteLength);

  archive.set(CTXBRIDGE_MAGIC, 0);
  writeUint16BE(CTXBRIDGE_VERSION, archive, 8);
  writeUint16BE(flags, archive, 10);
  archive.set(payload, headerLen);

  return archive;
}
