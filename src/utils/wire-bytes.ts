/**
 * Byte transport for extension messaging and extension storage.
 *
 * Values must survive both structured clone (Firefox) and JSON (Chromium messaging/storage).
 * A plain number[] survives both but costs roughly 10x the memory of the bytes; base64 costs
 * 1.33x and is a primitive string everywhere.
 */

export interface WireBytes {
  b64: string;
}

const CHUNK = 0x8000;

/**
 * Copies bytes into a Uint8Array that belongs to the current realm.
 *
 * Firefox MV3 content scripts get fetch() responses and TextEncoder output from the page realm.
 * A view over such a buffer is created in the page realm with a prototype the page may not
 * read, so subarray/slice/map on it throw 'Permission denied to access property "constructor"'.
 * TypedArray.prototype.set copies natively and never looks at that prototype.
 */
export function ownBytes(src: ArrayBuffer | ArrayBufferView): Uint8Array {
  const view = ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function bytesToBase64(bytes: Uint8Array): string {
  try {
    return encodeBase64(bytes);
  } catch {
    // Bytes from another realm (see ownBytes): copy them into this one first.
    return encodeBase64(ownBytes(bytes));
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toWireBytes(bytes: Uint8Array): WireBytes {
  return { b64: bytesToBase64(bytes) };
}

/**
 * Accepts every shape bytes take on the wire: WireBytes, typed arrays (also from another
 * realm), ArrayBuffer, number[], or a JSON-ified typed array ({"0": 12, "1": 34, ...}).
 */
export function fromWireBytes(data: unknown): Uint8Array {
  if (data == null) return new Uint8Array(0);
  if (ArrayBuffer.isView(data)) {
    return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
    return new Uint8Array(data as ArrayBuffer);
  }
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data === 'object') {
    const b64 = (data as { b64?: unknown }).b64;
    if (typeof b64 === 'string') return base64ToBytes(b64);
    return Uint8Array.from(Object.values(data as Record<string, number>));
  }
  return new Uint8Array(0);
}
