import { describe, it, expect } from 'vitest';
import { buildArchive } from '../../src/core/archive/writer';
import { readArchive } from '../../src/core/archive/reader';
import { ConversationSnapshot, CANONICAL_SCHEMA_VERSION, StoredBlob } from '../../src/core/model/canonical';
import { computeSha256 } from '../../src/core/hashing/sha256';
import { SecurityBoundsExceededError, ArchiveCorruptError } from '../../src/core/errors/errors';
import { BOUNDS } from '../../src/core/model/validation';

describe('Security Hardening and Integrity Tests', () => {
  it('prevents path traversal via malicious filenames in blobs', async () => {
    const data = new TextEncoder().encode('harmless text');
    const sha = await computeSha256(data);

    const blobs = new Map<string, StoredBlob>();
    blobs.set(sha, {
      metadata: {
        sha256: sha,
        mimeType: 'text/plain',
        byteSize: data.byteLength,
        filename: '../../../../etc/passwd', // Attempted path traversal
        role: 'attachment',
      },
      data,
    });

    const snapshot: ConversationSnapshot = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      id: 'snap-sec-1',
      sourcePlatform: 'chatgpt',
      capturedAt: '2026-09-28T12:00:00Z',
      messages: [
        {
          id: 'turn-1',
          role: 'user',
          sequence: 1,
          content: [{ type: 'file', blobSha256: sha, filename: '../../../../etc/passwd', mimeType: 'text/plain' }],
        },
      ],
      attachments: Array.from(blobs.values()).map((b) => b.metadata),
    };

    const archive = await buildArchive(snapshot, blobs, { compress: false });
    const result = await readArchive(archive);

    // ContextBridge stores blobs purely by content-addressed SHA-256 in memory/CBOR,
    // never extracting directly to the file system without sanitization.
    const retrieved = result.blobs.get(sha);
    expect(retrieved).toBeDefined();
    expect(retrieved?.data).toEqual(data);
  });

  it('rejects archives exceeding message bounds (anti-DOS / memory exhaustion)', async () => {
    const excessiveMessages: ConversationSnapshot['messages'] = Array.from(
      { length: BOUNDS.MAX_MESSAGES + 1 },
      (_, i) => ({
        id: `msg-${i}`,
        role: 'user' as const,
        sequence: i,
        content: [{ type: 'text' as const, text: 'a' }],
      })
    );

    const snapshot: ConversationSnapshot = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      id: 'snap-bomb',
      sourcePlatform: 'chatgpt',
      capturedAt: '2026-09-28T12:00:00Z',
      messages: excessiveMessages,
      attachments: [],
    };

    await expect(buildArchive(snapshot, new Map())).rejects.toThrow(SecurityBoundsExceededError);
  });

  it('rejects corrupted or truncated records', async () => {
    const rawArchive = new Uint8Array([
      0x43, 0x54, 0x58, 0x42, 0x52, 0x44, 0x47, 0x31, // CTXBRDG1
      0x00, 0x01, // Version 1
      0x00, 0x00, // Flags None
      0x4d, 0x45, 0x54, 0x41, // Tag 'META'
      0x00, 0x00, 0x05, 0x00, // Length 1280 bytes (but file ends immediately!)
    ]);

    await expect(readArchive(rawArchive)).rejects.toThrow(ArchiveCorruptError);
  });
});
