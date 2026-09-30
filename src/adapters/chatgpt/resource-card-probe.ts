/**
 * Development ResourceCardProbe for ChatGPT user file cards.
 *
 * Activates ONE live, mounted resource-card button and records what ChatGPT does in response
 * (network requests, blob URLs, previews/dialogs, downloads, navigation) so the real
 * byte-resolution mechanism can be discovered. It never resolves or synthesizes file bytes.
 *
 * Lifecycle (order matters):
 *   1. install MAIN-world hooks (fetch / XHR / window.open / createObjectURL / anchor click)
 *   2. confirm the nonce bridge is ready
 *   3. record baselines, install MutationObserver + PerformanceObserver
 *   4. activate the exact mounted button (pointer sequence + click)
 *   5. observe for ~1.5–2.5 s (ends early after a quiet period once the minimum elapsed)
 *   6. collect results
 *   7. restore UI (close preview, focus, scroll, URL)
 *   8. remove every hook and observer
 *
 * The function never throws: every failure is reported inside the returned diagnostic.
 */

import { DetectedUserFileCard } from './file-card-detector';
import {
  ResourceCardButtonState,
  ResourceCardProbeDiagnostic,
  ResourceCardProbeObservedUrl,
} from '../../core/diagnostics/diagnostics';
import {
  installResourceCardProbeHooks,
  mainWorldProbeArgsList,
  MainWorldProbeInstallArgs,
  MAIN_WORLD_PROBE_CLEANUP_PREFIX,
  MAIN_WORLD_PROBE_EVENT_PREFIX,
} from './probe-main-world';
import { hasLayout, isRendered } from './active-thread';

export type MainWorldProbeInstaller = (
  args: MainWorldProbeInstallArgs
) => Promise<{ ok: boolean; error?: string }>;

export interface ProbeOptions {
  /** Upper bound of the post-activation observation window (default 2500 ms). */
  probeTimeoutMs?: number;
  /** Minimum observation time before a quiet period may end it (default 1500 ms, capped by probeTimeoutMs). */
  probeMinWaitMs?: number;
  /** Extension-provided MAIN-world installer (background scripting.executeScript world: 'MAIN'). */
  installMainWorld?: MainWorldProbeInstaller;
  /** Awaited right before activation so the caller can persist an in-progress checkpoint. */
  onBeforeActivate?: () => Promise<void> | void;
  /** Suppress window.open and programmatic anchor navigations/downloads while probing (default true). */
  suppressNavigation?: boolean;
}

const MAX_OBSERVED_URLS = 40;
const FILE_RELATED_URL =
  /\/backend-api\/(files|estuary|content|attachments?)\b|oaiusercontent\.com|\/files?\/|\/download\b|\/attachments?\//i;
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
// The CSS `i` flag is ASCII-only, so Cyrillic labels are listed in both cases.
export const CLOSE_BUTTON_SELECTOR =
  'button[aria-label*="close" i], button[aria-label*="Закрыть"], button[aria-label*="закрыть"], [data-testid*="close" i], button.close';
const PANEL_SELECTOR = 'aside, [role="complementary"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog';

// ── small helpers ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(10);
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export function isElementConnected(el: unknown): boolean {
  return Boolean(el && (el as { isConnected?: boolean }).isConnected === true);
}

function sanitizeUrl(rawUrl: string, baseHref?: string): { url: string; queryKeys?: string[] } {
  const raw = String(rawUrl || '');
  if (!raw) return { url: '' };
  if (raw.startsWith('blob:')) {
    try {
      return { url: `blob:${new URL(raw.slice(5)).origin}` };
    } catch {
      return { url: 'blob:' };
    }
  }
  if (raw.startsWith('data:')) {
    const end = raw.search(/[;,]/);
    return { url: `data:${raw.slice(5, end > 5 ? Math.min(end, 65) : 65)}` };
  }
  try {
    const parsed = new URL(raw, baseHref || 'https://chatgpt.com/');
    const keys: string[] = [];
    parsed.searchParams.forEach((_v, k) => {
      if (keys.length < 20 && !keys.includes(k)) keys.push(k.slice(0, 40));
    });
    return { url: `${parsed.origin}${parsed.pathname}`, queryKeys: keys.length > 0 ? keys : undefined };
  } catch {
    return { url: raw.split(/[?#]/)[0]!.slice(0, 150) };
  }
}

/** Replaces ID-like path segments so the endpoint shape is visible without identifiers. */
export function toUrlPattern(sanitizedUrl: string): string {
  const schemeEnd = sanitizedUrl.indexOf('://');
  if (schemeEnd === -1) return sanitizedUrl;
  const pathStart = sanitizedUrl.indexOf('/', schemeEnd + 3);
  if (pathStart === -1) return sanitizedUrl;
  const origin = sanitizedUrl.slice(0, pathStart);
  const segments = sanitizedUrl
    .slice(pathStart)
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
      if (/^file[-_][A-Za-z0-9]{6,}$/.test(seg)) return '{file-id}';
      if (/^[A-Za-z0-9_-]{16,}$/.test(seg) && /\d/.test(seg)) return '{id}';
      return seg;
    });
  return origin + segments.join('/');
}

function describeElement(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  const tag = el.tagName?.toLowerCase() || 'unknown';
  const role = el.getAttribute?.('role');
  const testId = el.getAttribute?.('data-testid');
  const label = el.getAttribute?.('aria-label');
  return [
    tag,
    role ? `role=${role}` : '',
    testId ? `testid=${testId.slice(0, 40)}` : '',
    label ? `label=${label.slice(0, 40)}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function readButtonState(el: Element, win: Window | null): ResourceCardButtonState {
  let inViewport: boolean | undefined;
  try {
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    if (rect && win) {
      inViewport = rect.bottom > 0 && rect.top < (win.innerHeight || 0) && rect.width + rect.height > 0;
    }
  } catch {
    // ignore
  }
  return {
    ariaExpanded: el.getAttribute('aria-expanded') ?? undefined,
    ariaPressed: el.getAttribute('aria-pressed') ?? undefined,
    ariaHaspopup: el.getAttribute('aria-haspopup') ?? undefined,
    ariaControls: el.getAttribute('aria-controls') ?? undefined,
    dataState: el.getAttribute('data-state') ?? undefined,
    disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
    inViewport,
  };
}

function safeAttributes(el: Element, baseHref?: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (let i = 0; i < (el.attributes?.length || 0); i++) {
    const attr = el.attributes[i]!;
    const name = attr.name.toLowerCase();
    if (name === 'href' || name === 'src' || name === 'data') {
      attrs[name] = sanitizeUrl(attr.value, baseHref).url;
    } else if (
      name === 'role' ||
      name === 'download' ||
      name === 'data-testid' ||
      name === 'data-state' ||
      name === 'type' ||
      (name.startsWith('aria-') && name !== 'aria-describedby')
    ) {
      attrs[name] = attr.value.slice(0, 80);
    }
  }
  return attrs;
}

export interface ScrollSnapshotEntry {
  el: Element | null; // null = window
  top: number;
  left: number;
}

export function snapshotScrollPositions(button: Element, doc: Document, win: Window | null): ScrollSnapshotEntry[] {
  const out: ScrollSnapshotEntry[] = [];
  let cur: Element | null = button.parentElement;
  while (cur) {
    const h = cur as HTMLElement;
    if (h.scrollHeight > h.clientHeight || h.scrollWidth > h.clientWidth || h.scrollTop !== 0) {
      out.push({ el: cur, top: h.scrollTop, left: h.scrollLeft });
    }
    cur = cur.parentElement;
  }
  const scrolling = doc.scrollingElement as HTMLElement | null;
  if (scrolling && !out.some((e) => e.el === scrolling)) {
    out.push({ el: scrolling, top: scrolling.scrollTop, left: scrolling.scrollLeft });
  }
  if (win) out.push({ el: null, top: win.scrollY || 0, left: win.scrollX || 0 });
  return out;
}

export function restoreScrollPositions(entries: ScrollSnapshotEntry[], win: Window | null): boolean {
  let allRestored = true;
  for (const entry of entries) {
    try {
      if (entry.el === null) {
        if (win && typeof win.scrollTo === 'function' && (win.scrollY !== entry.top || win.scrollX !== entry.left)) {
          win.scrollTo(entry.left, entry.top);
        }
        continue;
      }
      const h = entry.el as HTMLElement;
      if (!h.isConnected) continue;
      if (h.scrollTop !== entry.top) h.scrollTop = entry.top;
      if (h.scrollLeft !== entry.left) h.scrollLeft = entry.left;
      if (Math.abs(h.scrollTop - entry.top) > 2) allRestored = false;
    } catch {
      allRestored = false;
    }
  }
  return allRestored;
}

export function dispatchEscape(doc: Document, win: Window | null): void {
  const KeyboardCtor = (win as any)?.KeyboardEvent || (globalThis as any).KeyboardEvent;
  const target = (doc.activeElement as HTMLElement | null) || doc.body;
  if (typeof KeyboardCtor !== 'function' || !target) return;
  for (const type of ['keydown', 'keyup']) {
    try {
      target.dispatchEvent(new KeyboardCtor(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    } catch {
      // ignore
    }
  }
}

export function isPanelStillOpen(el: Element, doc: Document): boolean {
  if (!el.isConnected) return false;
  if (el.getAttribute('data-state') === 'closed' || el.getAttribute('aria-hidden') === 'true') return false;
  // An emptied portal container stays in the page after its panel closed.
  if (el.childElementCount === 0 && !el.textContent?.trim()) return false;
  return !hasLayout(doc) || isRendered(el);
}

/**
 * UI that appeared because of an activation: new dialogs, side panels (<aside>, the live
 * preview panel) and body-level portals. Tooltips are ignored.
 */
export function collectOpenedPanels(doc: Document, addedRoots: Element[], dialogsBefore: Set<Element>): Element[] {
  const panels: Element[] = [];
  const push = (el: Element | null | undefined) => {
    if (!el || !el.isConnected || panels.includes(el)) return;
    if (el.matches?.('[role="tooltip"]')) return;
    panels.push(el);
  };
  for (const d of openDialogs(doc)) {
    if (!dialogsBefore.has(d)) push(d);
  }
  for (const root of addedRoots) {
    if (!root.isConnected) continue;
    if (root.matches?.(PANEL_SELECTOR)) push(root);
    else if (root.parentElement === doc.body && !root.querySelector?.('[role="tooltip"]')) push(root);
    else push(root.querySelector?.(PANEL_SELECTOR));
  }
  return panels.slice(0, 10);
}

/** Close buttons first, then Escape; reports what is still open (with its button labels). */
export async function closeOpenedPanels(
  doc: Document,
  win: Window | null,
  panels: Element[],
  settleMs: number
): Promise<{
  closeButtonsClicked: number;
  escapeDispatched: boolean;
  stillOpen: number;
  panelButtons?: Array<{ ariaLabel?: string; testId?: string; title?: string }>;
}> {
  const report: {
    closeButtonsClicked: number;
    escapeDispatched: boolean;
    stillOpen: number;
    panelButtons?: Array<{ ariaLabel?: string; testId?: string; title?: string }>;
  } = { closeButtonsClicked: 0, escapeDispatched: false, stillOpen: 0 };
  // Closing is often animated: keep checking for a while instead of judging after one pause.
  const waitForClosed = async () => {
    await sleep(settleMs);
    const deadline = Date.now() + (hasLayout(doc) ? 900 : 0);
    while (panels.some((p) => isPanelStillOpen(p, doc)) && Date.now() < deadline) await sleep(60);
  };
  for (const panel of panels) {
    if (!isPanelStillOpen(panel, doc)) continue;
    const closeBtn = panel.querySelector<HTMLElement>(CLOSE_BUTTON_SELECTOR);
    if (closeBtn) {
      try {
        closeBtn.click();
        report.closeButtonsClicked++;
      } catch {
        // ignore
      }
    }
  }
  if (report.closeButtonsClicked > 0) await waitForClosed();
  if (panels.some((p) => isPanelStillOpen(p, doc))) {
    dispatchEscape(doc, win);
    report.escapeDispatched = true;
    await waitForClosed();
  }
  const open = panels.filter((p) => isPanelStillOpen(p, doc));
  report.stillOpen = open.length;
  if (open[0]) {
    // UI labels only (no text content), so the next iteration can learn how to close it.
    report.panelButtons = Array.from(open[0].querySelectorAll('button'))
      .slice(0, 8)
      .map((b) => ({
        ariaLabel: b.getAttribute('aria-label')?.slice(0, 40) || undefined,
        testId: b.getAttribute('data-testid')?.slice(0, 40) || undefined,
        title: b.getAttribute('title')?.slice(0, 40) || undefined,
      }));
  }
  return report;
}

export function openDialogs(doc: Document): Element[] {
  try {
    return Array.from(doc.querySelectorAll(DIALOG_SELECTOR));
  } catch {
    return [];
  }
}

// ── MAIN-world bridge ──────────────────────────────────────────────────

interface MainWorldBridge {
  info: NonNullable<ResourceCardProbeDiagnostic['mainWorld']>;
  cleanup(): void;
}

async function installMainWorldBridge(
  doc: Document,
  card: DetectedUserFileCard,
  options: ProbeOptions,
  autoCleanupMs: number,
  onEvent: (evt: Record<string, any>) => void
): Promise<MainWorldBridge> {
  const nonce = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const eventName = `${MAIN_WORLD_PROBE_EVENT_PREFIX}${nonce}`;
  const cleanupEventName = `${MAIN_WORLD_PROBE_CLEANUP_PREFIX}${nonce}`;
  const info: MainWorldBridge['info'] = {
    ready: false,
    method: 'none',
    hooks: [],
    attempts: [],
    eventsReceived: 0,
  };

  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail !== 'string') return;
    let evt: Record<string, any>;
    try {
      evt = JSON.parse(detail);
    } catch {
      return;
    }
    if (!evt || typeof evt.kind !== 'string') return;
    if (evt.kind === 'ready') {
      info.ready = true;
      info.hooks = Array.isArray(evt.hooks) ? evt.hooks.slice(0, 20).map(String) : [];
      return;
    }
    if (evt.kind === 'cleanup') {
      info.cleanup = String(evt.reason || 'unknown');
      return;
    }
    info.eventsReceived++;
    onEvent(evt);
  };
  doc.addEventListener(eventName, listener);

  const args: MainWorldProbeInstallArgs = {
    eventName,
    cleanupEventName,
    autoCleanupMs,
    expectedFilename: card.filename,
    suppressNavigation: options.suppressNavigation !== false,
  };

  // Method 1: extension MAIN-world injection (not subject to the page CSP).
  if (options.installMainWorld) {
    const started = Date.now();
    const method = 'scripting.executeScript(MAIN)';
    try {
      const res = await withTimeout(options.installMainWorld(args), 3000, 'main_world_install_timeout');
      const ready = res?.ok ? await waitUntil(() => info.ready, 500) : false;
      info.attempts.push({
        method,
        ok: ready,
        error: res?.ok ? (ready ? undefined : 'ready_event_not_received') : String(res?.error || 'install_failed'),
        durationMs: Date.now() - started,
      });
      if (ready) info.method = method;
    } catch (err) {
      info.attempts.push({ method, ok: false, error: errorMessage(err), durationMs: Date.now() - started });
    }
  }

  // Method 2: inline <script> (may be blocked by the page CSP).
  if (!info.ready) {
    const started = Date.now();
    const method = 'inline-script';
    try {
      const script = doc.createElement('script');
      script.textContent = `(${installResourceCardProbeHooks.toString()})(${mainWorldProbeArgsList(args)
        .map((a) => JSON.stringify(a))
        .join(',')});`;
      (doc.head || doc.documentElement).appendChild(script);
      script.remove();
      const ready = await waitUntil(() => info.ready, 150);
      info.attempts.push({
        method,
        ok: ready,
        error: ready ? undefined : 'ready_event_not_received (inline script blocked by page CSP or not executed)',
        durationMs: Date.now() - started,
      });
      if (ready) info.method = method;
    } catch (err) {
      info.attempts.push({ method, ok: false, error: errorMessage(err), durationMs: Date.now() - started });
    }
  }

  let cleaned = false;
  return {
    info,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        // Synchronous: the page-side listener restores every original and acks with {kind:'cleanup'}.
        doc.dispatchEvent(new CustomEvent(cleanupEventName));
      } catch {
        // ignore
      }
      doc.removeEventListener(eventName, listener);
      if (info.ready && !info.cleanup) info.cleanup = 'requested_without_ack';
    },
  };
}

// ── activation ─────────────────────────────────────────────────────────

export function activateButton(
  button: HTMLElement,
  doc: Document,
  win: Window | null
): Array<{ type: string; defaultPrevented: boolean; error?: string }> {
  const dispatched: Array<{ type: string; defaultPrevented: boolean; error?: string }> = [];
  let clientX = 0;
  let clientY = 0;
  try {
    const rect = button.getBoundingClientRect();
    clientX = rect.left + rect.width / 2;
    clientY = rect.top + rect.height / 2;
  } catch {
    // ignore
  }
  const g = globalThis as any;
  const w = (win as any) || g;
  const PointerCtor = w.PointerEvent || g.PointerEvent;
  const MouseCtor = w.MouseEvent || g.MouseEvent;
  const base = { bubbles: true, cancelable: true, composed: true, clientX, clientY, detail: 1 };
  const pointerBase = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };

  const fire = (type: string, Ctor: any, init: Record<string, unknown>) => {
    if (typeof Ctor !== 'function') return;
    try {
      const notCancelled = button.dispatchEvent(new Ctor(type, init));
      dispatched.push({ type, defaultPrevented: !notCancelled });
    } catch (err) {
      dispatched.push({ type, defaultPrevented: false, error: errorMessage(err) });
    }
  };

  fire('pointerover', PointerCtor, { ...pointerBase, buttons: 0 });
  fire('mouseover', MouseCtor, { ...base, buttons: 0 });
  fire('pointerdown', PointerCtor, { ...pointerBase, button: 0, buttons: 1 });
  fire('mousedown', MouseCtor, { ...base, button: 0, buttons: 1 });
  try {
    button.focus({ preventScroll: true });
  } catch {
    // ignore
  }
  fire('pointerup', PointerCtor, { ...pointerBase, button: 0, buttons: 0 });
  fire('mouseup', MouseCtor, { ...base, button: 0, buttons: 0 });
  // A dispatched click reaches React/Radix handlers exactly like button.click(), but also
  // tells us whether the page called preventDefault().
  fire('click', MouseCtor, { ...base, button: 0, buttons: 0 });
  if (!dispatched.some((d) => d.type === 'click' && !d.error)) {
    try {
      button.click();
      dispatched.push({ type: 'click()', defaultPrevented: false });
    } catch (err) {
      dispatched.push({ type: 'click()', defaultPrevented: false, error: errorMessage(err) });
    }
  }
  return dispatched;
}

// ── main entry ─────────────────────────────────────────────────────────

export async function probeResourceCard(
  card: DetectedUserFileCard,
  doc: Document = document,
  options: ProbeOptions = {}
): Promise<ResourceCardProbeDiagnostic> {
  const startedAt = Date.now();
  const win: Window | null = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const button = card.buttonEl as HTMLElement;
  const baseHref = win?.location?.href;

  const diag: ResourceCardProbeDiagnostic = {
    filename: card.filename,
    turnKey: card.turnKey,
    unitKey: card.unitKey,
    attempted: true,
    completed: false,
    elementWasConnected: isElementConnected(button),
    error: null,
    buttonAriaLabel: card.ariaLabel,
    buttonClass: typeof button?.className === 'string' ? button.className.slice(0, 100) : undefined,
    spanTitle: card.spanTitle,
    stage: 'started',
  };

  if (!diag.elementWasConnected) {
    return {
      ...diag,
      result: 'element_not_connected',
      outcome: 'element_not_connected',
      error: 'Resource-card button element was not connected to document at probe time',
      stage: 'connection_check',
      probeDurationMs: 0,
    };
  }

  const maxWaitMs = Math.max(0, Math.min(options.probeTimeoutMs ?? 2500, 10_000));
  const minWaitMs = Math.min(options.probeMinWaitMs ?? 1500, maxWaitMs);
  const quietMs = Math.min(400, maxWaitMs);
  const settleMs = Math.min(300, maxWaitMs);

  const observedUrls: ResourceCardProbeObservedUrl[] = [];
  const blobUrlsCreated: NonNullable<ResourceCardProbeDiagnostic['blobUrlsCreated']> = [];
  const historyEvents: string[] = [];
  let activatedAt = 0;
  let lastSignalAt = 0;
  let collecting = true;
  let eventsDuringRestore = 0;
  const teardown: Array<() => void> = [];
  const runTeardown = () => {
    while (teardown.length > 0) {
      try {
        teardown.pop()!();
      } catch {
        // ignore
      }
    }
  };

  const pushUrl = (entry: ResourceCardProbeObservedUrl) => {
    if (observedUrls.length >= MAX_OBSERVED_URLS) return;
    entry.urlPattern = toUrlPattern(entry.sanitizedUrl);
    entry.fileRelated = FILE_RELATED_URL.test(entry.sanitizedUrl) || entry.sanitizedUrl.startsWith('blob:');
    observedUrls.push(entry);
  };

  try {
    // 1 + 2. MAIN-world hooks, confirmed ready BEFORE the click.
    const bridge = await installMainWorldBridge(doc, card, options, maxWaitMs + 12_000, (evt) => {
      if (!collecting) {
        eventsDuringRestore++;
        return;
      }
      if (evt.kind === 'fetch-start' || evt.kind === 'xhr-start') {
        lastSignalAt = Date.now();
        return; // completion events carry the full record
      }
      lastSignalAt = Date.now();
      const offsetMs = activatedAt && typeof evt.t === 'number' ? evt.t - activatedAt : undefined;
      if (evt.kind === 'blob-url-created') {
        blobUrlsCreated.push({
          objectType: String(evt.objectType || 'unknown'),
          size: typeof evt.size === 'number' ? evt.size : undefined,
          mimeType: evt.mimeType ? String(evt.mimeType) : undefined,
          nameMatchesCard: typeof evt.nameMatchesCard === 'boolean' ? evt.nameMatchesCard : undefined,
          offsetMs,
        });
        return;
      }
      if (typeof evt.kind === 'string' && evt.kind.startsWith('history-')) {
        historyEvents.push(`${evt.kind}:${toUrlPattern(String(evt.url || ''))}`);
        return;
      }
      pushUrl({
        kind: String(evt.kind),
        source: 'main-world',
        sanitizedUrl: String(evt.url || ''),
        queryKeys: Array.isArray(evt.queryKeys) ? evt.queryKeys.map(String) : undefined,
        method: evt.method ? String(evt.method) : undefined,
        status: typeof evt.status === 'number' ? evt.status : undefined,
        contentType: evt.contentType ? String(evt.contentType).slice(0, 100) : undefined,
        contentDisposition: evt.contentDisposition ? String(evt.contentDisposition) : undefined,
        contentLength: evt.contentLength ? String(evt.contentLength) : undefined,
        responseUrl: evt.responseUrl && evt.responseUrl !== evt.url ? String(evt.responseUrl) : undefined,
        jsonShape: evt.jsonShape,
        hasDownloadAttr: typeof evt.hasDownloadAttr === 'boolean' ? evt.hasDownloadAttr : undefined,
        suppressed: typeof evt.suppressed === 'boolean' ? evt.suppressed : undefined,
        durationMs: typeof evt.durationMs === 'number' ? evt.durationMs : undefined,
        offsetMs,
      });
    });
    teardown.push(() => bridge.cleanup());
    diag.mainWorld = bridge.info;
    diag.stage = 'hooks_installed';
    const hooksReadyMs = Date.now() - startedAt;

    // 3. Baselines + observers.
    const perf: Performance | undefined =
      (win as any)?.performance || (typeof performance !== 'undefined' ? performance : undefined);
    const timeOrigin = perf?.timeOrigin || Date.now() - (perf?.now?.() || 0);
    const seenPerfKeys = new Set<string>();
    try {
      for (const e of (perf?.getEntriesByType?.('resource') || []) as PerformanceResourceTiming[]) {
        seenPerfKeys.add(`${e.name}|${e.startTime}`);
      }
    } catch {
      // ignore
    }
    diag.initialResourceCount = seenPerfKeys.size;

    const addPerfEntry = (e: PerformanceResourceTiming) => {
      const key = `${e.name}|${e.startTime}`;
      if (seenPerfKeys.has(key)) return;
      seenPerfKeys.add(key);
      if (!collecting) {
        eventsDuringRestore++;
        return;
      }
      lastSignalAt = Date.now();
      const s = sanitizeUrl(e.name, baseHref);
      const status = (e as unknown as { responseStatus?: number }).responseStatus;
      pushUrl({
        kind: 'performance-resource',
        source: 'performance',
        sanitizedUrl: s.url,
        queryKeys: s.queryKeys,
        initiatorType: e.initiatorType || undefined,
        transferSize: typeof e.transferSize === 'number' ? e.transferSize : undefined,
        decodedBodySize: typeof e.decodedBodySize === 'number' ? e.decodedBodySize : undefined,
        status: typeof status === 'number' && status > 0 ? status : undefined,
        durationMs: Math.round(e.duration || 0),
        offsetMs: activatedAt ? Math.round(timeOrigin + e.startTime - activatedAt) : undefined,
      });
    };

    const PerfObserverCtor: typeof PerformanceObserver | undefined =
      (win as any)?.PerformanceObserver ||
      (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : undefined);
    if (PerfObserverCtor) {
      try {
        const po = new PerfObserverCtor((list) => {
          for (const entry of list.getEntries()) addPerfEntry(entry as PerformanceResourceTiming);
        });
        po.observe({ type: 'resource', buffered: false } as PerformanceObserverInit);
        teardown.push(() => po.disconnect());
      } catch {
        // ignore
      }
    }

    const dialogsBefore = new Set(openDialogs(doc));
    const scrollSnapshot = snapshotScrollPositions(button, doc, win);
    const focusBeforeEl = doc.activeElement;
    const locationBefore = win?.location?.href || '';
    const buttonBefore = readButtonState(button, win);
    diag.focusBefore = describeElement(focusBeforeEl);

    const addedRoots: Element[] = [];
    const domChanges: NonNullable<ResourceCardProbeDiagnostic['domChanges']> = {
      addedElements: 0,
      attributeChanges: 0,
      dialogsOpened: 0,
      tooltipsAdded: 0,
      iframesAdded: 0,
      imagesAdded: 0,
      downloadLinksAdded: 0,
    };

    const MutationObserverCtor: typeof MutationObserver | undefined =
      (win as any)?.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : undefined);
    const observeRoot = doc.body || doc.documentElement;
    if (MutationObserverCtor && observeRoot) {
      const mo = new MutationObserverCtor((mutations) => {
        if (!collecting) return;
        for (const m of mutations) {
          if (m.type === 'attributes') {
            domChanges.attributeChanges++;
            const target = m.target as Element;
            if (m.attributeName === 'href' || m.attributeName === 'src') {
              const value = target.getAttribute?.(m.attributeName);
              if (value && !value.startsWith('#') && !/^javascript:/i.test(value)) {
                lastSignalAt = Date.now();
                pushUrl({
                  kind: value.startsWith('blob:') ? 'blob' : m.attributeName,
                  source: 'dom',
                  sanitizedUrl: sanitizeUrl(value, baseHref).url,
                  hasDownloadAttr: target.hasAttribute?.('download') || undefined,
                  offsetMs: activatedAt ? Date.now() - activatedAt : undefined,
                });
              }
            }
            continue;
          }
          for (let i = 0; i < m.addedNodes.length; i++) {
            const node = m.addedNodes[i];
            if (!node || node.nodeType !== 1) continue;
            const el = node as Element;
            domChanges.addedElements++;
            if (addedRoots.length < 200) addedRoots.push(el);

            const role = el.getAttribute('role');
            if (role === 'tooltip' || el.querySelector?.('[role="tooltip"]')) domChanges.tooltipsAdded++;

            const urlCarriers: Element[] = [el, ...Array.from(el.querySelectorAll?.('a[href], iframe[src], embed[src], object[data], img[src], video[src], source[src]') || [])];
            for (const cand of urlCarriers) {
              const tag = cand.tagName.toLowerCase();
              const href = cand.getAttribute('href');
              const src = cand.getAttribute('src') || cand.getAttribute('data');
              const value = href || src;
              if (!value || value.startsWith('#') || /^javascript:/i.test(value)) continue;
              if (tag === 'iframe' || tag === 'embed' || tag === 'object') domChanges.iframesAdded++;
              if (tag === 'img') domChanges.imagesAdded++;
              if (tag === 'a' && cand.hasAttribute('download')) domChanges.downloadLinksAdded++;
              lastSignalAt = Date.now();
              pushUrl({
                kind: value.startsWith('blob:') ? 'blob' : `dom-${tag}`,
                source: 'dom',
                sanitizedUrl: sanitizeUrl(value, baseHref).url,
                hasDownloadAttr: tag === 'a' ? cand.hasAttribute('download') : undefined,
                offsetMs: activatedAt ? Date.now() - activatedAt : undefined,
              });
            }
          }
        }
      });
      mo.observe(observeRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'src', 'open', 'aria-expanded', 'aria-hidden', 'data-state'],
      });
      teardown.push(() => mo.disconnect());
    }

    // Anchor clicks that bubble through the document: attached download links, and the case
    // where the card itself is wrapped in a link (our own click would otherwise navigate away).
    const onDocumentClick = (event: Event) => {
      if (!collecting) return;
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href]');
      if (!anchor) return;
      const hrefAttr = anchor.getAttribute('href') || '';
      const hasDownload = anchor.hasAttribute('download');
      const navigates = hrefAttr !== '' && !hrefAttr.startsWith('#') && !/^javascript:/i.test(hrefAttr);
      const suppress = options.suppressNavigation !== false && (hasDownload || navigates);
      if (suppress) event.preventDefault();
      lastSignalAt = Date.now();
      pushUrl({
        kind: anchor.contains(button) ? 'card-anchor-click' : 'dom-anchor-click',
        source: 'dom',
        sanitizedUrl: sanitizeUrl((anchor as HTMLAnchorElement).href || hrefAttr, baseHref).url,
        hasDownloadAttr: hasDownload,
        suppressed: suppress,
        offsetMs: activatedAt ? Date.now() - activatedAt : undefined,
      });
    };
    doc.addEventListener('click', onDocumentClick, true);
    teardown.push(() => doc.removeEventListener('click', onDocumentClick, true));

    // 4. Activate the exact mounted button (checkpoint first, so an unload cannot erase evidence).
    if (options.onBeforeActivate) {
      try {
        await options.onBeforeActivate();
      } catch {
        // persistence failure must not block the probe
      }
    }
    if (!isElementConnected(button)) {
      diag.elementWasConnected = false;
      diag.result = 'element_not_connected';
      diag.outcome = 'element_not_connected';
      diag.error = 'Resource-card button was unmounted while hooks were being installed';
      return diag;
    }
    diag.stage = 'activating';
    activatedAt = Date.now();
    lastSignalAt = activatedAt;
    const dispatched = activateButton(button, doc, win);
    diag.stage = 'activated';
    diag.activation = { method: 'pointer-sequence+click', dispatched, buttonBefore };

    // 5. Observation window (min..max, ends early after a quiet period).
    while (true) {
      const elapsed = Date.now() - activatedAt;
      if (elapsed >= maxWaitMs) break;
      if (elapsed >= minWaitMs && Date.now() - lastSignalAt >= quietMs) break;
      await sleep(Math.min(100, maxWaitMs - elapsed));
    }
    const observationMs = Date.now() - activatedAt;
    diag.stage = 'observed';

    // 6. Collect.
    try {
      for (const e of (perf?.getEntriesByType?.('resource') || []) as PerformanceResourceTiming[]) {
        addPerfEntry(e);
      }
    } catch {
      // ignore
    }
    collecting = false;

    const newDialogs = openDialogs(doc).filter((d) => !dialogsBefore.has(d));
    for (const root of addedRoots) {
      if (!root.isConnected) continue;
      if (root.matches?.(DIALOG_SELECTOR) || root.tagName.toLowerCase() === 'dialog') {
        if (!newDialogs.includes(root)) newDialogs.push(root);
      }
    }
    domChanges.dialogsOpened = newDialogs.length;
    diag.domChanges = domChanges;
    diag.newModalsOrDialogs = newDialogs.slice(0, 10).map((d) => {
      const text = (d.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        tagName: d.tagName.toLowerCase(),
        role: d.getAttribute('role') || undefined,
        ariaLabel: d.getAttribute('aria-label')?.slice(0, 80) || undefined,
        testId: d.getAttribute('data-testid')?.slice(0, 60) || undefined,
        textLength: text.length,
        containsFilename: card.filename ? text.includes(card.filename) : false,
        hasIframe: Boolean(d.querySelector('iframe, embed, object')),
        hasImage: Boolean(d.querySelector('img')),
        hasPre: Boolean(d.querySelector('pre, code')),
        hasDownloadLink: Boolean(d.querySelector('a[download], a[href^="blob:"]')),
        buttonLabels: Array.from(d.querySelectorAll('button[aria-label], a[aria-label]'))
          .map((b) => (b.getAttribute('aria-label') || '').slice(0, 40))
          .filter(Boolean)
          .slice(0, 8),
      };
    });
    diag.newElementsCreated = addedRoots
      .filter((el) => !addedRoots.some((other) => other !== el && other.contains(el)))
      .slice(0, 15)
      .map((el) => ({
        tagName: el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className.slice(0, 80) : undefined,
        attributes: safeAttributes(el, baseHref),
      }));

    const buttonAfter = readButtonState(button, win);
    diag.activation.buttonAfter = buttonAfter;
    diag.activation.buttonStillConnected = isElementConnected(button);
    diag.focusAfterActivation = describeElement(doc.activeElement);
    const locationAfter = win?.location?.href || '';
    diag.locationChanged = locationAfter !== locationBefore;
    if (diag.locationChanged) diag.locationAfter = toUrlPattern(sanitizeUrl(locationAfter).url);
    diag.observedUrls = observedUrls;
    diag.blobUrlsCreated = blobUrlsCreated;

    // Signals + most byte-relevant result.
    const isNetwork = (u: ResourceCardProbeObservedUrl) =>
      u.source === 'performance' || u.kind === 'fetch' || u.kind === 'xhr' || u.kind === 'fetch-error';
    const signals = new Set<string>();
    if (blobUrlsCreated.length > 0 || observedUrls.some((u) => u.sanitizedUrl.startsWith('blob:'))) {
      signals.add('blob_url_created');
    }
    if (observedUrls.some((u) => /attachment/i.test(u.contentDisposition || ''))) signals.add('download_response_observed');
    if (observedUrls.some((u) => u.hasDownloadAttr && /anchor-click$/.test(u.kind))) {
      signals.add('download_anchor_clicked');
    }
    if (observedUrls.some((u) => u.kind === 'window-open')) signals.add('window_open_called');
    if (observedUrls.some((u) => u.kind === 'card-anchor-click')) signals.add('card_link_activated');
    if (observedUrls.some((u) => isNetwork(u) && u.fileRelated)) signals.add('file_endpoint_requested');
    if (newDialogs.length > 0) signals.add('modal_opened');
    if (diag.locationChanged || historyEvents.length > 0) signals.add('location_changed');
    if (observedUrls.some(isNetwork)) signals.add('network_request_observed');
    const { inViewport: _vb, ...stateBefore } = buttonBefore;
    const { inViewport: _va, ...stateAfter } = buttonAfter;
    if (JSON.stringify(stateBefore) !== JSON.stringify(stateAfter)) signals.add('button_state_changed');
    if (domChanges.addedElements > 0 || domChanges.attributeChanges > 0) signals.add('dom_changed');
    const priority = [
      'blob_url_created',
      'download_response_observed',
      'download_anchor_clicked',
      'window_open_called',
      'card_link_activated',
      'file_endpoint_requested',
      'modal_opened',
      'location_changed',
      'network_request_observed',
      'button_state_changed',
      'dom_changed',
    ];
    diag.signals = priority.filter((s) => signals.has(s));
    if (historyEvents.length > 0) diag.signals.push(...historyEvents.slice(0, 5).map((h) => `history:${h}`));
    diag.result = priority.find((s) => signals.has(s)) || 'no_network_or_dom_signal';
    diag.outcome = diag.result;

    // 7. Restore UI (hooks stay active so closing the preview cannot navigate away).
    const restoreStarted = Date.now();
    const restore: NonNullable<ResourceCardProbeDiagnostic['restore']> = {
      closeButtonsClicked: 0,
      escapeDispatched: false,
      dialogsStillOpen: 0,
      focusRestored: false,
      scrollRestored: false,
      historyBackCalled: false,
    };
    // Dialogs, side panels (<aside>: the live preview panel) and body-level portals.
    const panels = collectOpenedPanels(doc, addedRoots, dialogsBefore);
    const closeReport = await closeOpenedPanels(doc, win, panels, settleMs);
    restore.closeButtonsClicked = closeReport.closeButtonsClicked;
    restore.escapeDispatched = closeReport.escapeDispatched;
    const expandedNow = () => {
      const s = readButtonState(button, win);
      return s.ariaExpanded === 'true' || s.dataState === 'open';
    };
    if (!restore.escapeDispatched && expandedNow()) {
      dispatchEscape(doc, win);
      restore.escapeDispatched = true;
      await sleep(settleMs);
    }
    if (win && (win.location?.href || '') !== locationBefore) {
      // Only undo a route the probe itself PUSHED; history.back() after a replaceState (or with
      // no MAIN-world evidence) could leave the conversation entirely.
      if (historyEvents.some((h) => h.startsWith('history-pushState'))) {
        try {
          win.history.back();
          restore.historyBackCalled = true;
          await sleep(Math.max(settleMs, 150));
        } catch {
          // ignore
        }
      }
      restore.locationRestored = (win.location?.href || '') === locationBefore;
    }
    restore.dialogsStillOpen = panels.filter((p) => isPanelStillOpen(p, doc)).length;
    try {
      const previous = focusBeforeEl as HTMLElement | null;
      if (previous && previous !== doc.body && isElementConnected(previous) && typeof previous.focus === 'function') {
        previous.focus({ preventScroll: true });
      }
      if (doc.activeElement === button && previous !== button) button.blur();
      restore.focusRestored =
        doc.activeElement === previous ||
        (doc.activeElement !== button && (!previous || previous === doc.body));
    } catch {
      // ignore
    }
    restore.scrollRestored = restoreScrollPositions(scrollSnapshot, win);
    diag.restore = restore;

    diag.timings = {
      hooksReadyMs,
      activatedAtMs: activatedAt - startedAt,
      observationMs,
      restoreMs: Date.now() - restoreStarted,
    };
    diag.stage = 'restored';
    diag.completed = true;
  } catch (err) {
    diag.error = errorMessage(err);
    diag.result = 'probe_threw_exception';
    diag.outcome = 'probe_error';
    diag.completed = false;
  } finally {
    // 8. Remove every hook, observer and listener.
    runTeardown();
    if (diag.mainWorld) diag.mainWorld.eventsDuringRestore = eventsDuringRestore;
    diag.probeDurationMs = Date.now() - startedAt;
  }

  return diag;
}
