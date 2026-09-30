/**
 * ContextBridge Archive Format v1 Specification Constants and Structures
 */

export const CTXBRIDGE_MAGIC = new Uint8Array([
  0x43, 0x54, 0x58, 0x42, 0x52, 0x44, 0x47, 0x31,
]); // "CTXBRDG1" in ASCII

export const CTXBRIDGE_VERSION = 1 as const;
export const CTXBRIDGE_MIME_TYPE = 'application/x-contextbridge' as const;
export const CTXBRIDGE_FILE_EXTENSION = '.ctxbridge' as const;

export const FLAGS = {
  NONE: 0x0000,
  ENCRYPTED: 0x0001,
  COMPRESSED: 0x0002,
} as const;

export const RECORD_TAGS = {
  META: 'META',
  CONV: 'CONV',
  BLOB: 'BLOB',
  EOF: 'EOF_',
} as const;

export type RecordTag = (typeof RECORD_TAGS)[keyof typeof RECORD_TAGS];

export interface ArchiveManifest {
  schemaVersion: number;
  generator: string;
  createdAt: string;
  sourcePlatform: string;
  title?: string;
  messageCount: number;
  attachmentCount: number;
  totalBlobBytes: number;
}

export function writeUint16BE(value: number, target: Uint8Array, offset: number): void {
  target[offset] = (value >> 8) & 0xff;
  target[offset + 1] = value & 0xff;
}

export function readUint16BE(source: Uint8Array, offset: number): number {
  const b0 = source[offset] ?? 0;
  const b1 = source[offset + 1] ?? 0;
  return (b0 << 8) | b1;
}

export function writeUint32BE(value: number, target: Uint8Array, offset: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

export function readUint32BE(source: Uint8Array, offset: number): number {
  const b0 = source[offset] ?? 0;
  const b1 = source[offset + 1] ?? 0;
  const b2 = source[offset + 2] ?? 0;
  const b3 = source[offset + 3] ?? 0;
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

export function tagToBytes(tag: string): Uint8Array {
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    bytes[i] = tag.charCodeAt(i) & 0xff;
  }
  return bytes;
}

export function bytesToTag(bytes: Uint8Array, offset: number = 0): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const b = bytes[offset + i];
    s += String.fromCharCode(b !== undefined ? b : 0);
  }
  return s;
}

export function matchesMagic(bytes: Uint8Array): boolean {
  if (bytes.length < CTXBRIDGE_MAGIC.length) return false;
  for (let i = 0; i < CTXBRIDGE_MAGIC.length; i++) {
    if (bytes[i] !== CTXBRIDGE_MAGIC[i]) return false;
  }
  return true;
}
