/**
 * Captures the REAL bytes of ChatGPT uploaded-file cards through ChatGPT's own resolution chain
 * (observed live by the resource-card probe):
 *   click card -> GET /backend-api/files/download/{file_id} -> { download_url }
 *              -> GET download_url (/backend-api/estuary/content?...) -> bytes
 * The page's own content response is cloned when it fetches it (text previews do); otherwise the
 * exact download_url ChatGPT returned is fetched from the page context. When ChatGPT shows a
 * preview from its cache (only files/{id}/simple goes out), its own files/download request is
 * repeated for that file id with the URL and headers it used. No bytes are synthesized: a card
 * only counts as resolved when bytes were actually received and provably belong to it (its
 * download_url, its file id, or its name in Content-Disposition).
 *
 * One session per capture: MAIN-world hooks are installed once, armed around each card
 * activation, and removed with close().
 */

import { DetectedUserFileCard } from './file-card-detector';
import {
  activateButton,
  closeOpenedPanels,
  collectOpenedPanels,
  isElementConnected,
  openDialogs,
  restoreScrollPositions,
  snapshotScrollPositions,
} from './resource-card-probe';
import {
  FILE_CAPTURE_COMMAND_PREFIX,
  FILE_CAPTURE_EVENT_PREFIX,
  FileCaptureInstallArgs,
  fileCaptureArgsList,
  installFileCaptureHooks,
} from './file-capture-main-world';
import type { FileCardResolutionDiagnostic } from '../../core/diagnostics/diagnostics';

export type FileCaptureInstaller = (args: FileCaptureInstallArgs) => Promise<{ ok: boolean; error?: string }>;

export interface CapturedFileBytes {
  turnKey: string;
  filename: string;
  data: Uint8Array;
  mimeType: string;
}

export interface FileCaptureSession {
  readonly ready: boolean;
  readonly method: string;
  readonly installError?: string;
  resolveCard(
    card: DetectedUserFileCard,
    attemptNumber?: number
  ): Promise<{ diagnostic: FileCardResolutionDiagnostic; bytes?: CapturedFileBytes }>;
  /**
   * Late pass for a card whose file id is already known (its click only produced ChatGPT's
   * cached metadata): repeats ChatGPT's own download request without clicking again.
   */
  resolveByFileId(
    card: Pick<DetectedUserFileCard, 'filename' | 'turnKey'>,
    fileId: string,
    attemptNumber?: number
  ): Promise<{ diagnostic: FileCardResolutionDiagnostic; bytes?: CapturedFileBytes }>;
  close(): void;
}

export interface FileCaptureOptions {
  install?: FileCaptureInstaller;
  /** Per-file cap (default 25 MB). */
  maxBytes?: number;
  /** How long to wait for ChatGPT's files/download answer after the click (default 12 s). */
  cardTimeoutMs?: number;
  /** How long to wait for the page's own content fetch before fetching download_url (default 2.5 s). */
  pageFetchGraceMs?: number;
  /**
   * After ChatGPT's files/simple answer, how long to wait for its files/download request before
   * concluding the preview came from its cache and repeating the download ourselves (default 2.5 s).
   */
  metaGraceMs?: number;
  /** Timeout for our own download_url fetch (default 20 s). */
  fetchTimeoutMs?: number;
  /**
   * Before a card is activated, file traffic must have been quiet this long (default 400 ms,
   * at most 1.5 s of waiting), so late answers to the previous card cannot pass for this one's.
   */
  quietMs?: number;
  /** Safety net: hooks remove themselves after this long (default 15 min). */
  autoCleanupMs?: number;
  /** Delay for UI to react when closing the preview panel (default 300 ms). */
  settleMs?: number;
}

type HookEvent = Record<string, any>;

const FILE_TRAFFIC_EVENTS = new Set(['download-info', 'file-meta', 'content-bytes', 'content-skipped']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(20);
  }
  return true;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function normalizeName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/** File name from a Content-Disposition header (RFC 6266 filename* first, then filename). */
export function dispositionFilename(header: unknown): string | undefined {
  if (typeof header !== 'string' || !header) return undefined;
  const star = header.match(/filename\*\s*=\s*[\w!#$%&+^`{}~.-]*'[^']*'([^;]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"(.*)"$/, '$1'));
    } catch {
      // malformed percent-encoding: fall back to the plain parameter
    }
  }
  const plain = header.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i) ?? header.match(/filename\s*=\s*([^;]+)/i);
  const name = plain?.[1]?.replace(/\\(.)/g, '$1').trim();
  return name || undefined;
}

function mimeEssence(contentType?: string): string | undefined {
  const essence = contentType?.split(';')[0]?.trim().toLowerCase();
  return essence && essence !== 'application/octet-stream' ? essence : undefined;
}

function inferMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    html: 'text/html',
    xml: 'application/xml',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

function trackAddedRoots(doc: Document): { roots: Element[]; stop(): void } {
  const roots: Element[] = [];
  const Ctor = (doc.defaultView as any)?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : undefined);
  const target = doc.body || doc.documentElement;
  if (!Ctor || !target) return { roots, stop() {} };
  const mo = new Ctor((mutations: MutationRecord[]) => {
    for (const m of mutations) {
      for (let i = 0; i < m.addedNodes.length; i++) {
        const node = m.addedNodes[i];
        if (node && node.nodeType === 1 && roots.length < 200) roots.push(node as Element);
      }
    }
  });
  mo.observe(target, { childList: true, subtree: true });
  return { roots, stop: () => mo.disconnect() };
}

export async function openFileCaptureSession(doc: Document, options: FileCaptureOptions = {}): Promise<FileCaptureSession> {
  const win: Window | null = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const cardTimeoutMs = options.cardTimeoutMs ?? 12_000;
  const pageFetchGraceMs = options.pageFetchGraceMs ?? 2_500;
  const metaGraceMs = options.metaGraceMs ?? 2_500;
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 20_000;
  const settleMs = options.settleMs ?? 300;
  const quietMs = options.quietMs ?? 400;

  const nonce = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const args: FileCaptureInstallArgs = {
    eventName: `${FILE_CAPTURE_EVENT_PREFIX}${nonce}`,
    commandEventName: `${FILE_CAPTURE_COMMAND_PREFIX}${nonce}`,
    autoCleanupMs: options.autoCleanupMs ?? 15 * 60 * 1000,
    maxBytes,
  };

  let ready = false;
  let method = 'none';
  const errors: string[] = [];
  const listeners = new Set<(evt: HookEvent) => void>();
  // Last time any file traffic answered (also after a card's window closed).
  let lastFileEventAt = 0;
  // file id -> the card its bytes were captured for.
  const claimedFileIds = new Map<string, string>();
  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string') return;
    let evt: HookEvent;
    try {
      evt = JSON.parse(detail);
    } catch {
      return;
    }
    if (!evt || typeof evt.kind !== 'string') return;
    if (evt.kind === 'ready') {
      ready = true;
      return;
    }
    if (FILE_TRAFFIC_EVENTS.has(evt.kind)) lastFileEventAt = Date.now();
    for (const l of listeners) l(evt);
  };
  doc.addEventListener(args.eventName, onEvent);

  // 1. Extension MAIN-world injection (not subject to the page CSP).
  if (options.install) {
    try {
      const res = await Promise.race([
        options.install(args),
        sleep(3000).then(() => ({ ok: false, error: 'install_timeout' })),
      ]);
      if (res.ok && (await waitUntil(() => ready, 500))) method = 'scripting.executeScript(MAIN)';
      else errors.push(`scripting: ${res.ok ? 'ready_event_not_received' : res.error || 'failed'}`);
    } catch (err) {
      errors.push(`scripting: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 2. Inline <script> fallback (may be blocked by the page CSP).
  if (!ready) {
    try {
      const script = doc.createElement('script');
      script.textContent = `(${installFileCaptureHooks.toString()})(${fileCaptureArgsList(args)
        .map((a) => JSON.stringify(a))
        .join(',')});`;
      (doc.head || doc.documentElement).appendChild(script);
      script.remove();
      if (await waitUntil(() => ready, 150)) method = 'inline-script';
      else errors.push('inline-script: blocked or not executed');
    } catch (err) {
      errors.push(`inline-script: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const send = (cmd: Record<string, unknown>) => {
    try {
      doc.dispatchEvent(new CustomEvent(args.commandEventName, { detail: JSON.stringify(cmd) }));
    } catch {
      // ignore
    }
  };

  let closed = false;
  let requestSeq = 0;

  /** Sends a command that answers with one fetch-result event and waits for it. */
  function request(cmd: Record<string, unknown>, timeoutMs: number): Promise<HookEvent | undefined> {
    const requestId = `r${++requestSeq}`;
    return new Promise((resolve) => {
      let done = false;
      const listener = (evt: HookEvent) => {
        if (done || evt.kind !== 'fetch-result' || evt.requestId !== requestId) return;
        done = true;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(evt);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        listeners.delete(listener);
        resolve(undefined);
      }, timeoutMs);
      listeners.add(listener);
      send({ ...cmd, requestId });
    });
  }

  /** Copies what a replayed download reported into the diagnostic. */
  function noteReplay(diag: FileCardResolutionDiagnostic, result: HookEvent | undefined, wanted: string): void {
    diag.replaySource = typeof result?.replaySource === 'string' ? result.replaySource : undefined;
    if (typeof result?.downloadStatus === 'string') diag.downloadStatus = result.downloadStatus;
    if (typeof result?.fileSizeBytes === 'number') diag.expectedByteSize = result.fileSizeBytes;
    if (typeof result?.fileName === 'string') diag.nameMatched = normalizeName(result.fileName) === wanted;
    const status = result?.httpStatus ?? result?.downloadHttpStatus;
    if (typeof status === 'number') diag.httpStatus = status;
  }

  async function resolveCard(
    card: DetectedUserFileCard,
    attemptNumber = 1
  ): Promise<{ diagnostic: FileCardResolutionDiagnostic; bytes?: CapturedFileBytes }> {
    const started = Date.now();
    const diag: FileCardResolutionDiagnostic = {
      filename: card.filename,
      turnKey: card.turnKey,
      attempted: true,
      status: 'unresolved',
      attemptNumber,
    };
    const finish = (bytes?: CapturedFileBytes) => {
      diag.durationMs = Date.now() - started;
      return { diagnostic: diag, bytes };
    };
    if (!ready || closed) {
      diag.reason = 'capture_hooks_unavailable';
      return finish();
    }
    const button = card.buttonEl as HTMLElement;
    if (!isElementConnected(button)) {
      diag.reason = 'card_not_mounted';
      return finish();
    }

    // Late answers to the previous card land first, so they cannot pass for this card's.
    await waitUntil(() => Date.now() - lastFileEventAt >= quietMs, 1500);
    if (!isElementConnected(button)) {
      diag.reason = 'card_not_mounted';
      return finish();
    }

    const events: HookEvent[] = [];
    const listener = (evt: HookEvent) => events.push(evt);
    listeners.add(listener);
    const tracker = trackAddedRoots(doc);
    const dialogsBefore = new Set(openDialogs(doc));
    const scrollSnapshot = snapshotScrollPositions(button, doc, win);
    const focusBefore = doc.activeElement as HTMLElement | null;
    const cardKey = `${card.turnKey}\u0000${card.filename}`;
    const wanted = normalizeName(card.filename);
    const nameMatches = (name: unknown) => typeof name === 'string' && normalizeName(name) === wanted;
    // A file id already captured for another card only counts with this card's own name (the
    // same upload shown in two turns).
    const claimedByOther = (id: unknown) =>
      typeof id === 'string' && claimedFileIds.has(id) && claimedFileIds.get(id) !== cardKey;
    const preferred = (e: HookEvent, kind: string) =>
      e.kind === kind && (nameMatches(e.fileName) || (typeof e.fileName !== 'string' && !claimedByOther(e.fileId)));
    const acceptable = (e: HookEvent, kind: string) =>
      e.kind === kind && (nameMatches(e.fileName) || !claimedByOther(e.fileId));
    // Content counts only when it provably belongs to this card: the download_url ChatGPT
    // returned for it, its file id in the content URL, or its name in Content-Disposition.
    // Anything else the page fetches meanwhile (generated images loading, other previews) is
    // someone else's bytes.
    const belongs = (e: HookEvent, withInfo: HookEvent | undefined, id: string | undefined) =>
      e.kind === 'content-bytes' &&
      (Boolean(withInfo?.downloadUrl && e.url === withInfo.downloadUrl) ||
        Boolean(id && e.contentId === id) ||
        nameMatches(dispositionFilename(e.contentDisposition)));

    let bytes: CapturedFileBytes | undefined;
    send({ op: 'arm' });
    try {
      activateButton(button, doc, win);

      // 1. ChatGPT's own files/download answer for this card (or content it fetched directly).
      let info: HookEvent | undefined;
      let meta: HookEvent | undefined;
      let firstInfoAt = 0;
      let firstMetaAt = 0;
      await waitUntil(() => {
        info = events.find((e) => preferred(e, 'download-info')) ?? info;
        meta = events.find((e) => preferred(e, 'file-meta')) ?? meta;
        if (!firstInfoAt && events.some((e) => acceptable(e, 'download-info'))) firstInfoAt = Date.now();
        if (!firstMetaAt && events.some((e) => acceptable(e, 'file-meta'))) firstMetaAt = Date.now();
        const knownId: string | undefined = info?.fileId ?? meta?.fileId;
        return (
          Boolean(info) ||
          events.some((e) => belongs(e, info, knownId)) ||
          (firstInfoAt > 0 && Date.now() - firstInfoAt > 1000) ||
          // Metadata only and no download request: ChatGPT is showing a cached preview.
          (firstMetaAt > 0 && !firstInfoAt && Date.now() - firstMetaAt > metaGraceMs)
        );
      }, cardTimeoutMs);
      // The server may store a slightly different name; an answer to this click still counts.
      info = info ?? events.find((e) => acceptable(e, 'download-info'));
      meta = meta ?? events.find((e) => acceptable(e, 'file-meta'));
      const fileId: string | undefined = info?.fileId ?? meta?.fileId;
      diag.fileId = fileId;
      if (info) {
        diag.downloadStatus = info.status;
        diag.httpStatus = info.httpStatus;
        diag.expectedByteSize = typeof info.fileSizeBytes === 'number' ? info.fileSizeBytes : undefined;
        diag.nameMatched = typeof info.fileName === 'string' ? normalizeName(info.fileName) === wanted : undefined;
      }

      const matchesContent = (e: HookEvent) => belongs(e, info, fileId);

      // 2. Prefer the bytes ChatGPT fetched itself (the preview does this for text files).
      let content: HookEvent | undefined;
      await waitUntil(() => {
        content = events.find(matchesContent);
        return Boolean(content) || !info?.downloadUrl;
      }, info?.downloadUrl ? pageFetchGraceMs : 0);
      if (content?.base64) {
        diag.method = 'page-fetch-capture';
      } else if (info?.downloadUrl && (info.status === undefined || info.status === 'success')) {
        // 3. Otherwise fetch the exact download_url ChatGPT returned, from the page context.
        const requestId = `r${++requestSeq}`;
        send({ op: 'fetch-content', requestId, url: info.downloadUrl });
        let result: HookEvent | undefined;
        await waitUntil(() => {
          result = events.find((e) => e.kind === 'fetch-result' && e.requestId === requestId);
          return Boolean(result);
        }, fetchTimeoutMs);
        if (result?.ok && result.base64) {
          content = result;
          diag.method = 'download-url-fetch';
        } else {
          diag.httpStatus = result?.httpStatus ?? diag.httpStatus;
          diag.reason = result ? `content_fetch_failed:${result.error || 'unknown'}` : 'content_fetch_timeout';
        }
      } else if (!info && fileId && !content?.base64) {
        // 4. ChatGPT answered from its cache: repeat its own download request for this file id.
        const result = await request({ op: 'fetch-download', fileId }, fetchTimeoutMs);
        noteReplay(diag, result, wanted);
        if (result?.ok && result.base64) {
          content = result;
          diag.method = 'replayed-download';
        } else {
          diag.reason = result ? `replay_failed:${result.error || 'unknown'}` : 'replay_timeout';
        }
      }

      const unrelated = events.filter((e) => e.kind === 'content-bytes' && !matchesContent(e)).length;
      if (unrelated > 0) diag.unrelatedContentIgnored = unrelated;

      if (content?.base64) {
        const data = base64ToBytes(String(content.base64));
        diag.byteSize = data.byteLength;
        if (diag.expectedByteSize !== undefined && diag.expectedByteSize !== data.byteLength) {
          diag.sizeMismatch = true;
        }
        const mimeType =
          mimeEssence(content.contentType) ||
          mimeEssence(info?.mimeType) ||
          mimeEssence(content.mimeType) ||
          mimeEssence(meta?.mimeType) ||
          inferMime(card.filename);
        diag.mimeType = mimeType;
        diag.status = 'resolved';
        bytes = { turnKey: card.turnKey, filename: card.filename, data, mimeType };
        const claimId = fileId ?? (typeof content.contentId === 'string' ? content.contentId : undefined);
        if (claimId) claimedFileIds.set(claimId, cardKey);
      } else if (!diag.reason) {
        const skipped = events.find((e) => e.kind === 'content-skipped');
        if (skipped) diag.reason = `content_${skipped.reason || 'skipped'}`;
        else if (!info && !meta) diag.reason = 'no_download_info';
        else if (info && info.status && info.status !== 'success') {
          diag.reason = `download_status_${info.status}${info.errorCode ? `:${info.errorCode}` : ''}`;
        } else if (info && !info.downloadUrl) diag.reason = 'download_url_missing';
        else diag.reason = 'no_content_received';
      }
    } catch (err) {
      diag.reason = `resolver_error:${err instanceof Error ? err.message : String(err)}`;
    } finally {
      send({ op: 'disarm' });
      listeners.delete(listener);
      diag.eventsSeen = Array.from(new Set(events.map((e) => String(e.kind)))).slice(0, 12);
    }

    // Close the preview panel the click opened, then restore focus and scroll.
    const panels = collectOpenedPanels(doc, tracker.roots, dialogsBefore);
    tracker.stop();
    diag.panelsOpened = panels.length;
    if (panels.length > 0) {
      const report = await closeOpenedPanels(doc, win, panels, settleMs);
      diag.panelsStillOpen = report.stillOpen;
      if (report.stillOpen > 0) diag.panelButtons = report.panelButtons;
    }
    try {
      if (focusBefore && focusBefore !== doc.body && isElementConnected(focusBefore)) {
        focusBefore.focus({ preventScroll: true });
      } else if (doc.activeElement === button) {
        button.blur();
      }
    } catch {
      // ignore
    }
    restoreScrollPositions(scrollSnapshot, win);
    return finish(bytes);
  }

  async function resolveByFileId(
    card: Pick<DetectedUserFileCard, 'filename' | 'turnKey'>,
    fileId: string,
    attemptNumber = 1
  ): Promise<{ diagnostic: FileCardResolutionDiagnostic; bytes?: CapturedFileBytes }> {
    const started = Date.now();
    const diag: FileCardResolutionDiagnostic = {
      filename: card.filename,
      turnKey: card.turnKey,
      attempted: true,
      status: 'unresolved',
      attemptNumber,
      fileId,
      latePass: true,
    };
    let bytes: CapturedFileBytes | undefined;
    if (!ready || closed) {
      diag.reason = 'capture_hooks_unavailable';
    } else {
      const result = await request({ op: 'fetch-download', fileId }, fetchTimeoutMs);
      noteReplay(diag, result, normalizeName(card.filename));
      if (result?.ok && result.base64) {
        const data = base64ToBytes(String(result.base64));
        diag.byteSize = data.byteLength;
        if (diag.expectedByteSize !== undefined && diag.expectedByteSize !== data.byteLength) diag.sizeMismatch = true;
        const mimeType = mimeEssence(result.contentType) || mimeEssence(result.mimeType) || inferMime(card.filename);
        diag.mimeType = mimeType;
        diag.method = 'replayed-download';
        diag.status = 'resolved';
        diag.eventsSeen = ['fetch-result'];
        bytes = { turnKey: card.turnKey, filename: card.filename, data, mimeType };
        claimedFileIds.set(fileId, `${card.turnKey}\u0000${card.filename}`);
      } else {
        diag.reason = result ? `replay_failed:${result.error || 'unknown'}` : 'replay_timeout';
      }
    }
    diag.durationMs = Date.now() - started;
    return { diagnostic: diag, bytes };
  }

  return {
    get ready() {
      return ready && !closed;
    },
    get method() {
      return method;
    },
    get installError() {
      return errors.length > 0 && !ready ? errors.join(' | ') : undefined;
    },
    resolveCard,
    resolveByFileId,
    close() {
      if (closed) return;
      closed = true;
      send({ op: 'cleanup' });
      doc.removeEventListener(args.eventName, onEvent);
      listeners.clear();
    },
  };
}
