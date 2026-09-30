import { describe, it, expect } from 'vitest';
import { ConversationSnapshot, CANONICAL_SCHEMA_VERSION, StoredBlob } from '../../src/core/model/canonical';
import { buildArchive } from '../../src/core/archive/writer';
import { readArchive, inspectArchiveHeader } from '../../src/core/archive/reader';
import { ArchiveCorruptError, UnsupportedArchiveVersionError } from '../../src/core/errors/errors';
import { computeSha256 } from '../../src/core/hashing/sha256';

describe('ContextBridge Archive Format v1', () => {
  async function createFixture() {
    const blob1Data = new TextEncoder().encode('Sample binary image payload 123');
    const blob1Sha = await computeSha256(blob1Data);

    const blobs = new Map<string, StoredBlob>();
    blobs.set(blob1Sha, {
      metadata: {
        sha256: blob1Sha,
        mimeType: 'image/png',
        byteSize: blob1Data.byteLength,
        filename: 'test-diagram.png',
        role: 'user-upload',
      },
      data: blob1Data,
    });

    const snapshot: ConversationSnapshot = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      id: 'snap-abc-123',
      sourcePlatform: 'chatgpt',
      title: 'Full Architecture Discussion',
      sourceUrl: 'https://chatgpt.com/c/test-chat',
      capturedAt: '2026-09-28T12:00:00.000Z',
      messages: [
        {
          id: 'turn-1',
          role: 'user',
          sequence: 1,
          content: [
            { type: 'text', text: 'Here is my diagram:' },
            { type: 'image', blobSha256: blob1Sha },
          ],
        },
        {
          id: 'turn-2',
          role: 'assistant',
          sequence: 2,
          content: [
            { type: 'markdown', markdown: 'I have analyzed your diagram.' },
            { type: 'code', code: 'console.log("ready");', language: 'typescript' },
            {
              type: 'table',
              headers: ['Col A', 'Col B'],
              rows: [['Val 1', 'Val 2']],
            },
          ],
        },
      ],
      attachments: Array.from(blobs.values()).map((b) => b.metadata),
    };

    return { snapshot, blobs, blob1Sha, blob1Data };
  }

  it('builds and reads an uncompressed archive losslessly', async () => {
    const { snapshot, blobs, blob1Sha, blob1Data } = await createFixture();

    const archiveBytes = await buildArchive(snapshot, blobs, { compress: false });
    expect(archiveBytes.byteLength).toBeGreaterThan(0);

    const header = inspectArchiveHeader(archiveBytes);
    expect(header.version).toBe(1);
    expect(header.isEncrypted).toBe(false);
    expect(header.isCompressed).toBe(false);

    const result = await readArchive(archiveBytes);
    expect(result.snapshot.id).toBe(snapshot.id);
    expect(result.snapshot.title).toBe(snapshot.title);
    expect(result.snapshot.messages).toHaveLength(2);
    expect(result.blobs.size).toBe(1);

    const retrievedBlob = result.blobs.get(blob1Sha);
    expect(retrievedBlob).toBeDefined();
    expect(retrievedBlob?.data).toEqual(blob1Data);
    expect(retrievedBlob?.metadata.filename).toBe('test-diagram.png');
  });

  it('builds and reads a compressed archive losslessly', async () => {
    const { snapshot, blobs, blob1Sha, blob1Data } = await createFixture();

    const archiveBytes = await buildArchive(snapshot, blobs, { compress: true });
    const header = inspectArchiveHeader(archiveBytes);
    expect(header.isCompressed).toBe(true);

    const result = await readArchive(archiveBytes);
    expect(result.snapshot.id).toBe(snapshot.id);
    expect(result.blobs.get(blob1Sha)?.data).toEqual(blob1Data);
  });

  it('rejects invalid magic bytes', async () => {
    const { snapshot, blobs } = await createFixture();
    const archiveBytes = await buildArchive(snapshot, blobs, { compress: false });

    // Corrupt magic header
    archiveBytes[0] = 0x00;
    archiveBytes[1] = 0x00;

    expect(() => inspectArchiveHeader(archiveBytes)).toThrow(ArchiveCorruptError);
    await expect(readArchive(archiveBytes)).rejects.toThrow(ArchiveCorruptError);
  });

  it('rejects unsupported future version', async () => {
    const { snapshot, blobs } = await createFixture();
    const archiveBytes = await buildArchive(snapshot, blobs, { compress: false });

    // Modify version from 1 to 9
    archiveBytes[9] = 9;

    expect(() => inspectArchiveHeader(archiveBytes)).toThrow(UnsupportedArchiveVersionError);
    await expect(readArchive(archiveBytes)).rejects.toThrow(UnsupportedArchiveVersionError);
  });

  it('rejects truncated archive gracefully', async () => {
    const { snapshot, blobs } = await createFixture();
    const archiveBytes = await buildArchive(snapshot, blobs, { compress: false });

    // Truncate halfway through
    const truncated = archiveBytes.subarray(0, Math.floor(archiveBytes.byteLength / 2));

    await expect(readArchive(truncated)).rejects.toThrow(ArchiveCorruptError);
  });

  it('rejects archive with tampered blob data (integrity check failure)', async () => {
    const { snapshot, blobs, blob1Sha } = await createFixture();
    // Build uncompressed so we can tamper directly with the blob body
    const archiveBytes = await buildArchive(snapshot, blobs, { compress: false });

    // Locate blob data in uncompressed archive and tamper 1 byte
    const modified = new Uint8Array(archiveBytes);
    // Find last byte and flip it
    modified[modified.byteLength - 1]! ^= 0xff;

    await expect(readArchive(modified, { verifyBlobHashes: true })).rejects.toThrow(
      /integrity check failed|CBOR|Truncated/
    );
  });
});
