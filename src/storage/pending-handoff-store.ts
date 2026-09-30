/**
 * "Start a new chat in X" deliveries waiting for their tab's content script.
 *
 * The background opens the target tab and records a small entry keyed by tab id. The target
 * content script asks for it once its page is ready (CLAIM_PENDING_HANDOFF) and the handoff is
 * built from the tray at that moment. Nothing large is stored here, and nothing depends on the
 * background staying alive while the target page loads.
 */

export interface PendingHandoff {
  targetPlatform: string;
  includeMediaFiles: boolean;
  createdAt: number;
  /** Claims handed out so far (a page reload after signing in claims again). */
  attempts: number;
}

export const PENDING_HANDOFF_TTL_MS = 10 * 60 * 1000;
export const PENDING_HANDOFF_MAX_ATTEMPTS = 3;

const STORAGE_KEY = 'cbPendingHandoffs';

type PendingMap = Record<string, PendingHandoff>;

/** Fast path within one background lifetime; storage covers event-page restarts. */
const memory = new Map<number, PendingHandoff>();

interface StorageAreaLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

function area(): StorageAreaLike | null {
  try {
    if (typeof browser === 'undefined') return null;
    const storage = browser.storage as unknown as Record<string, StorageAreaLike | undefined> | undefined;
    const candidate = storage?.session ?? storage?.local;
    return candidate && typeof candidate.get === 'function' ? candidate : null;
  } catch {
    return null;
  }
}

async function readMap(): Promise<PendingMap> {
  const a = area();
  if (!a) return {};
  try {
    const got = await a.get(STORAGE_KEY);
    const map = got?.[STORAGE_KEY];
    return map && typeof map === 'object' ? (map as PendingMap) : {};
  } catch {
    return {};
  }
}

async function writeMap(map: PendingMap): Promise<void> {
  const a = area();
  if (!a) return;
  const now = Date.now();
  for (const [key, value] of Object.entries(map)) {
    if (!value || now - value.createdAt > PENDING_HANDOFF_TTL_MS) delete map[key];
  }
  try {
    if (Object.keys(map).length === 0) await a.remove(STORAGE_KEY);
    else await a.set({ [STORAGE_KEY]: map });
  } catch {
    // best effort; the in-memory copy still serves this background lifetime
  }
}

export function isPendingHandoffUsable(pending: PendingHandoff, now = Date.now()): boolean {
  return now - pending.createdAt <= PENDING_HANDOFF_TTL_MS && pending.attempts < PENDING_HANDOFF_MAX_ATTEMPTS;
}

export async function setPendingHandoff(tabId: number, pending: PendingHandoff): Promise<void> {
  memory.set(tabId, pending);
  const map = await readMap();
  map[String(tabId)] = pending;
  await writeMap(map);
}

export async function getPendingHandoff(tabId: number): Promise<PendingHandoff | null> {
  const inMemory = memory.get(tabId);
  if (inMemory) return inMemory;
  const map = await readMap();
  const stored = map[String(tabId)];
  if (stored) memory.set(tabId, stored);
  return stored ?? null;
}

export async function removePendingHandoff(tabId: number): Promise<void> {
  memory.delete(tabId);
  const map = await readMap();
  if (!(String(tabId) in map)) return;
  delete map[String(tabId)];
  await writeMap(map);
}

export async function clearPendingHandoffs(): Promise<void> {
  memory.clear();
  const a = area();
  try {
    await a?.remove(STORAGE_KEY);
  } catch {
    // ignore
  }
}
