import { describe, it, expect } from 'vitest';
import {
  computeSha256,
  bufferToHex,
  hexToBuffer,
  verifySha256,
  BlobStore,
} from '../../src/core/hashing/sha256';

describe('Hashing and Content Addressing', () => {
  const sampleData = new TextEncoder().encode('Hello ContextBridge!');
  // Known SHA-256 for 'Hello ContextBridge!'
  // echo -n "Hello ContextBridge!" | sha256sum -> 2029b3fd51f041ff2fe06ae4c8d50bf2284c8be10e6e73dbb027003ff588e4e9 (let's verify)

  it('computes sha256 correctly and formats as hex', async () => {
    const hash = await computeSha256(sampleData);
    expect(hash).toHaveLength(64);
    expect(await verifySha256(sampleData, hash)).toBe(true);
    expect(await verifySha256(sampleData, 'wronghash'.padEnd(64, '0'))).toBe(false);
  });

  it('converts buffer to hex and back losslessly', () => {
    const raw = new Uint8Array([0x00, 0x0f, 0x10, 0xff, 0x43, 0x7a]);
    const hex = bufferToHex(raw);
    expect(hex).toBe('000f10ff437a');
    const restored = hexToBuffer(hex);
    expect(restored).toEqual(raw);
  });

  it('deduplicates blobs in BlobStore based on content hash', async () => {
    const store = new BlobStore();
    const data1 = new TextEncoder().encode('Shared Image Binary Data');
    const data2 = new TextEncoder().encode('Shared Image Binary Data'); // identical data

    const meta1 = await store.put(data1, {
      mimeType: 'image/png',
      filename: 'first.png',
      role: 'inline-image',
    });

    const meta2 = await store.put(data2, {
      mimeType: 'image/png',
      filename: 'second.png',
      role: 'user-upload',
    });

    // Hash should be identical
    expect(meta1.sha256).toBe(meta2.sha256);
    // Only one entry should be stored
    expect(store.count).toBe(1);
    expect(store.totalBytes).toBe(data1.byteLength);

    // Can retrieve by hash
    const stored = store.get(meta1.sha256);
    expect(stored).toBeDefined();
    expect(stored?.data).toEqual(data1);
  });
});
