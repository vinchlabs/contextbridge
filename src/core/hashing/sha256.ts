/**
 * Cryptographic hashing and content-addressing utilities for ContextBridge
 */

import { StoredBlob, BlobMetadata } from '../model/canonical';
import { ownBytes } from '../../utils/wire-bytes';

/**
 * Computes lowercase hex SHA-256 digest of binary data using Web Crypto API.
 */
export async function computeSha256(data: Uint8Array): Promise<string> {
  // Use crypto.subtle if available (browser & modern Node)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
    return bufferToHex(ownBytes(hashBuffer));
  }

  // Fallback to dynamic import of node:crypto if in Node test environment without web crypto
  try {
    const nodeCrypto = await import('node:crypto');
    return nodeCrypto.createHash('sha256').update(data).digest('hex');
  } catch {
    throw new Error('No crypto implementation available for SHA-256');
  }
}

/**
 * Converts a byte array to lowercase hex string.
 */
export function bufferToHex(buffer: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte !== undefined) {
      hex += byte.toString(16).padStart(2, '0');
    }
  }
  return hex;
}

/**
 * Converts a hex string back to a Uint8Array.
 */
export function hexToBuffer(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have an even length');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Validates that the data's SHA-256 matches the expected digest.
 */
export async function verifySha256(data: Uint8Array, expectedSha256Hex: string): Promise<boolean> {
  const actual = await computeSha256(data);
  return actual.toLowerCase() === expectedSha256Hex.toLowerCase();
}

/**
 * Content-Addressed Blob Storage and Deduplication Registry.
 * Guarantees each distinct binary payload is stored only once.
 */
export class BlobStore {
  private blobs = new Map<string, StoredBlob>();

  /**
   * Adds binary data to the store, computing its SHA-256 and deduplicating.
   * Returns the metadata with computed SHA-256 and byteSize.
   */
  async put(
    input: Uint8Array,
    metadata: Omit<BlobMetadata, 'sha256' | 'byteSize'>
  ): Promise<BlobMetadata> {
    // Stored bytes always belong to this realm, whatever produced them (see ownBytes).
    const data = ownBytes(input);
    const sha256 = await computeSha256(data);
    const byteSize = data.byteLength;

    const fullMetadata: BlobMetadata = {
      ...metadata,
      sha256,
      byteSize,
    };

    if (!this.blobs.has(sha256)) {
      this.blobs.set(sha256, {
        metadata: fullMetadata,
        data,
      });
    }

    return fullMetadata;
  }

  get(sha256: string): StoredBlob | undefined {
    return this.blobs.get(sha256.toLowerCase());
  }

  has(sha256: string): boolean {
    return this.blobs.has(sha256.toLowerCase());
  }

  getAll(): Map<string, StoredBlob> {
    return new Map(this.blobs);
  }

  getMetadataList(): BlobMetadata[] {
    return Array.from(this.blobs.values()).map((b) => b.metadata);
  }

  get totalBytes(): number {
    let sum = 0;
    for (const b of this.blobs.values()) {
      sum += b.data.byteLength;
    }
    return sum;
  }

  get count(): number {
    return this.blobs.size;
  }

  clear(): void {
    this.blobs.clear();
  }
}
