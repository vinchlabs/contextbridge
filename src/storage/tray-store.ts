/**
 * The "tray": the one conversation ContextBridge currently holds for moving into another chat.
 *
 * Written by the background after a capture and by the import page after opening a .ctxbridge
 * file; read by the popup, the import page and the background (new-chat delivery).
 *
 * Where it lives:
 * - storage.session (memory only, cleared when the browser closes) when it fits the quota;
 * - otherwise storage.local, which the background clears on browser startup, so a copied chat
 *   never outlives the browser session either way. "Clear" removes it immediately.
 *
 * Leaf module: only type imports from the core, no module-level side effects.
 */

import type { BlobMetadata, ConversationSnapshot, PlatformId, StoredBlob } from '../core/model/canonical';
import { base64ToBytes, bytesToBase64, type WireBytes } from '../utils/wire-bytes';

export const TRAY_KEYS = {
  ENTRY: 'cbTrayEntry',
  SUMMARY: 'cbTraySummary',
} as const;

/** storage.session allows 10 MB in total; leave room for the summary and pending deliveries. */
const SESSION_MAX_BYTES = 8 * 1024 * 1024;

export type TrayOrigin = 'capture' | 'file';

export interface TrayBlob {
  metadata: BlobMetadata;
  data: WireBytes;
}

export interface TrayEntry {
  version: 1;
  origin: TrayOrigin;
  /** Name of the opened .ctxbridge file (origin 'file'). */
  fileName?: string;
  savedAt: number;
  snapshot: ConversationSnapshot;
  blobs: TrayBlob[];
  /** The capture ran with files and images switched off. */
  attachmentsExcluded?: boolean;
}

export interface TraySummary {
  version: 1;
  origin: TrayOrigin;
  fileName?: string;
  savedAt: number;
  title: string;
  sourcePlatform: PlatformId;
  sourceUrl?: string;
  messageCount: number;
  imageCount: number;
  fileCount: number;
  totalBlobBytes: number;
  attachmentsExcluded?: boolean;
  /** Files and images present in the chat but marked "not included" (could not be read). */
  missingAttachmentCount?: number;
  /** 'session' = memory only; 'local' = on disk until the next browser start or Clear. */
  area: 'session' | 'local';
}

interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function storageArea(name: 'session' | 'local'): StorageAreaLike | null {
  try {
    if (typeof browser === 'undefined') return null;
    const area = (browser.storage as unknown as Record<string, StorageAreaLike | undefined> | undefined)?.[name];
    return area && typeof area.get === 'function' ? area : null;
  } catch {
    return null;
  }
}

const BOTH_KEYS = [TRAY_KEYS.ENTRY, TRAY_KEYS.SUMMARY];

export function isTrayEntry(value: unknown): value is TrayEntry {
  const v = value as Partial<TrayEntry> | null;
  return (
    !!v &&
    typeof v === 'object' &&
    v.version === 1 &&
    !!v.snapshot &&
    typeof v.snapshot === 'object' &&
    Array.isArray(v.snapshot.messages) &&
    Array.isArray(v.blobs)
  );
}

function isTraySummary(value: unknown): value is TraySummary {
  const v = value as Partial<TraySummary> | null;
  return !!v && typeof v === 'object' && v.version === 1 && typeof v.messageCount === 'number';
}

export function encodeTrayBlobs(blobs: Iterable<StoredBlob>): TrayBlob[] {
  return Array.from(blobs, (b) => ({ metadata: b.metadata, data: { b64: bytesToBase64(b.data) } }));
}

export interface DecodedTrayBlobs {
  blobMap: Map<string, StoredBlob>;
  /** Lets callers re-send a blob without base64-encoding its bytes again. */
  base64ByBytes: Map<Uint8Array, string>;
}

export function decodeTrayBlobs(entry: TrayEntry): DecodedTrayBlobs {
  const blobMap = new Map<string, StoredBlob>();
  const base64ByBytes = new Map<Uint8Array, string>();
  for (const b of entry.blobs) {
    const b64 = typeof b?.data?.b64 === 'string' ? b.data.b64 : '';
    const data = base64ToBytes(b64);
    blobMap.set(b.metadata.sha256, { metadata: b.metadata, data });
    base64ByBytes.set(data, b64);
  }
  return { blobMap, base64ByBytes };
}

export function makeTrayEntry(
  snapshot: ConversationSnapshot,
  blobs: Iterable<StoredBlob> | TrayBlob[],
  origin: TrayOrigin,
  extra: { fileName?: string; attachmentsExcluded?: boolean } = {}
): TrayEntry {
  const list = Array.from(blobs as Iterable<StoredBlob | TrayBlob>);
  const trayBlobs: TrayBlob[] = list.map((b) =>
    b.data instanceof Uint8Array || ArrayBuffer.isView(b.data)
      ? { metadata: b.metadata, data: { b64: bytesToBase64(b.data as Uint8Array) } }
      : (b as TrayBlob)
  );
  return {
    version: 1,
    origin,
    fileName: extra.fileName,
    savedAt: Date.now(),
    snapshot,
    blobs: trayBlobs,
    attachmentsExcluded: extra.attachmentsExcluded || undefined,
  };
}

export function summarizeTray(entry: TrayEntry, area: 'session' | 'local'): TraySummary {
  let imageCount = 0;
  let fileCount = 0;
  let totalBlobBytes = 0;
  for (const b of entry.blobs) {
    const mime = b.metadata?.mimeType || '';
    if (mime.startsWith('image/')) imageCount++;
    else fileCount++;
    totalBlobBytes += b.metadata?.byteSize || Math.floor(((b.data?.b64?.length || 0) * 3) / 4);
  }
  const snapshot = entry.snapshot;
  let missingAttachmentCount = 0;
  for (const msg of snapshot.messages) {
    for (const part of msg.content ?? []) {
      if (part.type === 'unknown' && (part.metadata as { reason?: unknown } | undefined)?.reason === 'not_captured') {
        missingAttachmentCount++;
      }
    }
  }
  return {
    version: 1,
    origin: entry.origin,
    fileName: entry.fileName,
    savedAt: entry.savedAt,
    title: (snapshot.title || '').trim() || 'Untitled conversation',
    sourcePlatform: snapshot.sourcePlatform,
    sourceUrl: snapshot.sourceUrl,
    messageCount: snapshot.messages.length,
    imageCount,
    fileCount,
    totalBlobBytes,
    attachmentsExcluded: entry.attachmentsExcluded,
    missingAttachmentCount: missingAttachmentCount || undefined,
    area,
  };
}

function estimateEntryBytes(entry: TrayEntry): number {
  let total = 0;
  try {
    total += JSON.stringify(entry.snapshot).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  for (const b of entry.blobs) total += (b.data?.b64?.length || 0) + 512;
  return total;
}

/** Replaces the tray. Returns the summary that was stored next to it. */
export async function saveTray(entry: TrayEntry): Promise<TraySummary> {
  const session = storageArea('session');
  const local = storageArea('local');

  if (session && estimateEntryBytes(entry) <= SESSION_MAX_BYTES) {
    try {
      const summary = summarizeTray(entry, 'session');
      await session.set({ [TRAY_KEYS.ENTRY]: entry, [TRAY_KEYS.SUMMARY]: summary });
      await local?.remove(BOTH_KEYS).catch(() => undefined);
      return summary;
    } catch {
      // Quota exceeded or area unavailable: fall back to local storage.
    }
  }

  if (!local) throw new Error('Extension storage is not available.');
  const summary = summarizeTray(entry, 'local');
  await local.set({ [TRAY_KEYS.ENTRY]: entry, [TRAY_KEYS.SUMMARY]: summary });
  await session?.remove(BOTH_KEYS).catch(() => undefined);
  return summary;
}

export async function loadTraySummary(): Promise<TraySummary | null> {
  for (const name of ['session', 'local'] as const) {
    const area = storageArea(name);
    if (!area) continue;
    try {
      const got = await area.get(TRAY_KEYS.SUMMARY);
      const summary = got?.[TRAY_KEYS.SUMMARY];
      if (isTraySummary(summary)) return summary;
    } catch {
      // try the next area
    }
  }
  return null;
}

export async function loadTrayEntry(): Promise<TrayEntry | null> {
  for (const name of ['session', 'local'] as const) {
    const area = storageArea(name);
    if (!area) continue;
    try {
      const got = await area.get(TRAY_KEYS.ENTRY);
      const entry = got?.[TRAY_KEYS.ENTRY];
      if (isTrayEntry(entry)) return entry;
    } catch {
      // try the next area
    }
  }
  return null;
}

export async function clearTray(): Promise<void> {
  await Promise.all(
    (['session', 'local'] as const).map((name) => storageArea(name)?.remove(BOTH_KEYS).catch(() => undefined))
  );
}

/** Called on browser startup: a copied chat must not survive the session on disk. */
export async function clearDiskTray(): Promise<void> {
  await storageArea('local')?.remove(BOTH_KEYS).catch(() => undefined);
}

/** Calls `onChange` whenever the tray is replaced or cleared. Returns an unsubscribe function. */
export function onTrayChanged(onChange: () => void): () => void {
  if (typeof browser === 'undefined' || !browser.storage?.onChanged) return () => undefined;
  const listener = (changes: Record<string, unknown>) => {
    if (changes && TRAY_KEYS.SUMMARY in changes) onChange();
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
