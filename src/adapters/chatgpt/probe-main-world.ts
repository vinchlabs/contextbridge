/**
 * MAIN-world instrumentation for the ChatGPT ResourceCardProbe (development diagnostics).
 *
 * `installResourceCardProbeHooks` is executed inside the page's own JavaScript realm:
 *   1. preferred: `browser.scripting.executeScript({ world: 'MAIN', func, args })` issued by the
 *      background script (not subject to the page CSP; Firefox 128+),
 *   2. fallback: an inline <script> element (can be blocked by the page CSP).
 *
 * The function MUST stay fully self-contained (no imports, no references to module scope),
 * because only its source text is transferred into the page.
 *
 * Bridge protocol (JSON strings only, so Firefox Xray wrappers never hide fields):
 *   page -> content script : document CustomEvent `eventName`, detail = JSON.stringify(event)
 *   content script -> page : document CustomEvent `cleanupEventName` removes every hook
 * The first event is `{ kind: 'ready', hooks: [...] }`, emitted once every hook is active.
 *
 * Privacy: URLs are reduced to origin + pathname. Query parameter VALUES are never sent (only
 * their names). Response bodies are never forwarded; for small JSON responses only the
 * structural shape (keys and value kinds) is reported.
 */

export const MAIN_WORLD_PROBE_EVENT_PREFIX = 'ctxbridge-probe-event-';
export const MAIN_WORLD_PROBE_CLEANUP_PREFIX = 'ctxbridge-probe-cleanup-';

export interface MainWorldProbeInstallArgs {
  eventName: string;
  cleanupEventName: string;
  autoCleanupMs: number;
  expectedFilename: string;
  suppressNavigation: boolean;
}

/** Positional argument order used by scripting.executeScript and the inline fallback. */
export function mainWorldProbeArgsList(
  args: MainWorldProbeInstallArgs
): [string, string, number, string, boolean] {
  return [
    args.eventName,
    args.cleanupEventName,
    args.autoCleanupMs,
    args.expectedFilename,
    args.suppressNavigation,
  ];
}

export function installResourceCardProbeHooks(
  eventName: string,
  cleanupEventName: string,
  autoCleanupMs: number,
  expectedFilename: string,
  suppressNavigation: boolean
): void {
  const w = window as any;
  const doc = document;
  const FLAG = '__ctxbridgeResourceCardProbe';
  const MAX_JSON_CHARS = 262144;

  // Re-entrancy: remove hooks left behind by an earlier probe that never cleaned up.
  try {
    if (w[FLAG] && typeof w[FLAG].cleanup === 'function') {
      w[FLAG].cleanup('superseded');
    }
  } catch {
    // ignore
  }

  let seq = 0;
  const emit = (evt: Record<string, unknown>): void => {
    try {
      evt.t = Date.now();
      doc.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(evt) }));
    } catch {
      // ignore
    }
  };

  const describeUrl = (raw: unknown): { url: string; queryKeys?: string[] } => {
    try {
      const s = String(raw ?? '');
      if (!s) return { url: '' };
      if (s.startsWith('blob:')) {
        return { url: `blob:${new URL(s.slice(5)).origin}` };
      }
      if (s.startsWith('data:')) {
        const end = s.search(/[;,]/);
        return { url: `data:${s.slice(5, end > 5 ? Math.min(end, 65) : 65)}` };
      }
      const u = new URL(s, location.href);
      const keys: string[] = [];
      u.searchParams.forEach((_value, key) => {
        if (keys.length < 20 && !keys.includes(key)) keys.push(key.slice(0, 40));
      });
      return { url: `${u.origin}${u.pathname}`, queryKeys: keys.length > 0 ? keys : undefined };
    } catch {
      return { url: 'unparseable' };
    }
  };

  const summarizeDisposition = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    const type = raw.split(';')[0]?.trim().toLowerCase() || 'unknown';
    const hasName = /filename\*?=/i.test(raw);
    if (!hasName) return type;
    const matches = expectedFilename !== '' && raw.includes(expectedFilename);
    let encodedMatch = false;
    try {
      encodedMatch = expectedFilename !== '' && raw.includes(encodeURIComponent(expectedFilename));
    } catch {
      // ignore
    }
    return `${type}; filename=${matches || encodedMatch ? '<matches-card>' : '<other>'}`;
  };

  const shapeOf = (value: unknown, depth: number): unknown => {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
      if (depth >= 3) return `array(${value.length})`;
      return { '[array]': value.length, item: value.length > 0 ? shapeOf(value[0], depth + 1) : undefined };
    }
    switch (typeof value) {
      case 'string':
        return /^(https?:|blob:)/i.test(value) ? `url:${describeUrl(value).url}` : 'string';
      case 'number':
      case 'boolean':
        return typeof value;
      case 'object': {
        if (depth >= 3) return 'object';
        const out: Record<string, unknown> = {};
        let count = 0;
        for (const key of Object.keys(value as object)) {
          if (count++ >= 40) {
            out['...'] = 'truncated';
            break;
          }
          out[key.slice(0, 60)] = shapeOf((value as Record<string, unknown>)[key], depth + 1);
        }
        return out;
      }
      default:
        return typeof value;
    }
  };

  const restorers: Array<() => void> = [];
  const hooks: string[] = [];

  // ── fetch ────────────────────────────────────────────────────────────
  const origFetch = w.fetch;
  if (typeof origFetch === 'function') {
    const hookedFetch = function (this: unknown, ...args: any[]) {
      const id = ++seq;
      const input = args[0];
      const init = args[1];
      let rawUrl: unknown = '';
      let method = 'GET';
      try {
        rawUrl = typeof input === 'string' ? input : (input?.url ?? input?.href ?? String(input));
        method = String(init?.method || input?.method || 'GET').toUpperCase();
      } catch {
        // ignore
      }
      const d = describeUrl(rawUrl);
      const startedAt = Date.now();
      emit({ kind: 'fetch-start', id, method, url: d.url, queryKeys: d.queryKeys });

      const promise: any = Reflect.apply(origFetch, this ?? w, args);
      try {
        promise.then(
          (res: any) => {
            const ev: Record<string, unknown> = {
              kind: 'fetch',
              id,
              method,
              url: d.url,
              queryKeys: d.queryKeys,
            };
            try {
              ev.status = res.status;
              ev.responseType = res.type;
              ev.redirected = res.redirected;
              ev.responseUrl = describeUrl(res.url).url;
              ev.contentType = res.headers.get('content-type') || undefined;
              ev.contentLength = res.headers.get('content-length') || undefined;
              ev.contentDisposition = summarizeDisposition(res.headers.get('content-disposition'));
              ev.durationMs = Date.now() - startedAt;
            } catch {
              // ignore
            }
            const contentType = String(ev.contentType || '');
            const declaredLength = Number(ev.contentLength || 0);
            if (/json/i.test(contentType) && !(declaredLength > MAX_JSON_CHARS)) {
              try {
                res
                  .clone()
                  .text()
                  .then(
                    (txt: string) => {
                      if (txt.length <= MAX_JSON_CHARS) {
                        try {
                          ev.jsonShape = shapeOf(JSON.parse(txt), 0);
                        } catch {
                          ev.jsonShape = 'unparseable';
                        }
                      } else {
                        ev.jsonShape = 'too_large';
                      }
                      emit(ev);
                    },
                    () => emit(ev)
                  );
                return;
              } catch {
                // fall through
              }
            }
            emit(ev);
          },
          (err: any) => {
            emit({ kind: 'fetch-error', id, method, url: d.url, error: String(err?.name || err) });
          }
        );
      } catch {
        // ignore
      }
      return promise;
    };
    w.fetch = hookedFetch;
    hooks.push('fetch');
    restorers.push(() => {
      if (w.fetch === hookedFetch) w.fetch = origFetch;
    });
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────
  const xhrProto = w.XMLHttpRequest?.prototype;
  if (xhrProto && typeof xhrProto.open === 'function' && typeof xhrProto.send === 'function') {
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;
    const hookedOpen = function (this: any, ...args: any[]) {
      try {
        this.__ctxbridgeProbe = {
          method: String(args[0] || 'GET').toUpperCase(),
          d: describeUrl(args[1]),
        };
      } catch {
        // ignore
      }
      return Reflect.apply(origOpen, this, args);
    };
    const hookedSend = function (this: any, ...args: any[]) {
      const meta = this.__ctxbridgeProbe;
      if (meta) {
        const id = ++seq;
        const startedAt = Date.now();
        emit({ kind: 'xhr-start', id, method: meta.method, url: meta.d.url, queryKeys: meta.d.queryKeys });
        try {
          this.addEventListener(
            'loadend',
            function (this: any) {
              try {
                emit({
                  kind: 'xhr',
                  id,
                  method: meta.method,
                  url: meta.d.url,
                  queryKeys: meta.d.queryKeys,
                  status: this.status,
                  responseUrl: describeUrl(this.responseURL).url,
                  responseType: this.responseType || 'text',
                  contentType: this.getResponseHeader('content-type') || undefined,
                  contentLength: this.getResponseHeader('content-length') || undefined,
                  contentDisposition: summarizeDisposition(this.getResponseHeader('content-disposition')),
                  durationMs: Date.now() - startedAt,
                });
              } catch {
                // ignore
              }
            },
            { once: true }
          );
        } catch {
          // ignore
        }
      }
      return Reflect.apply(origSend, this, args);
    };
    xhrProto.open = hookedOpen;
    xhrProto.send = hookedSend;
    hooks.push('xhr');
    restorers.push(() => {
      if (xhrProto.open === hookedOpen) xhrProto.open = origOpen;
      if (xhrProto.send === hookedSend) xhrProto.send = origSend;
    });
  }

  // ── window.open (suppressed while probing so no tab steals focus) ───
  const origWindowOpen = w.open;
  if (typeof origWindowOpen === 'function') {
    const hookedWindowOpen = function (this: unknown, ...args: any[]) {
      const d = describeUrl(args[0]);
      emit({
        kind: 'window-open',
        url: d.url,
        queryKeys: d.queryKeys,
        target: args[1] ? String(args[1]).slice(0, 40) : undefined,
        suppressed: suppressNavigation,
      });
      if (suppressNavigation) return null;
      return Reflect.apply(origWindowOpen, this ?? w, args);
    };
    w.open = hookedWindowOpen;
    hooks.push('window.open');
    restorers.push(() => {
      if (w.open === hookedWindowOpen) w.open = origWindowOpen;
    });
  }

  // ── URL.createObjectURL (reveals in-page Blob materialisation) ──────
  const urlCtor = w.URL;
  const origCreateObjectURL = urlCtor?.createObjectURL;
  if (typeof origCreateObjectURL === 'function') {
    const hookedCreateObjectURL = function (this: unknown, ...args: any[]) {
      const out = Reflect.apply(origCreateObjectURL, this ?? urlCtor, args);
      try {
        const obj = args[0];
        const isBlob = typeof w.Blob === 'function' && obj instanceof w.Blob;
        const isFile = typeof w.File === 'function' && obj instanceof w.File;
        emit({
          kind: 'blob-url-created',
          objectType: isFile ? 'File' : isBlob ? 'Blob' : String(obj?.constructor?.name || typeof obj),
          size: isBlob ? obj.size : undefined,
          mimeType: isBlob ? String(obj.type || '').slice(0, 100) : undefined,
          nameMatchesCard: isFile ? obj.name === expectedFilename : undefined,
        });
      } catch {
        // ignore
      }
      return out;
    };
    urlCtor.createObjectURL = hookedCreateObjectURL;
    hooks.push('URL.createObjectURL');
    restorers.push(() => {
      if (urlCtor.createObjectURL === hookedCreateObjectURL) urlCtor.createObjectURL = origCreateObjectURL;
    });
  }

  // ── HTMLAnchorElement.click (programmatic downloads / navigations) ──
  const anchorProto = w.HTMLAnchorElement?.prototype;
  if (anchorProto && typeof anchorProto.click === 'function') {
    const origAnchorClick = anchorProto.click;
    const hookedAnchorClick = function (this: any, ...args: any[]) {
      let suppress = false;
      try {
        const hrefAttr = String(this.getAttribute('href') || '');
        const hasDownload = this.hasAttribute('download');
        const navigates = hrefAttr !== '' && !hrefAttr.startsWith('#') && !/^javascript:/i.test(hrefAttr);
        suppress = suppressNavigation && (hasDownload || navigates);
        const d = describeUrl(this.href || hrefAttr);
        emit({
          kind: 'anchor-click',
          url: d.url,
          queryKeys: d.queryKeys,
          hasDownloadAttr: hasDownload,
          downloadNameMatchesCard: hasDownload ? this.getAttribute('download') === expectedFilename : undefined,
          target: String(this.getAttribute('target') || '').slice(0, 20) || undefined,
          isConnected: Boolean(this.isConnected),
          suppressed: suppress,
        });
      } catch {
        // ignore
      }
      if (suppress) return undefined;
      return Reflect.apply(origAnchorClick, this, args);
    };
    anchorProto.click = hookedAnchorClick;
    hooks.push('HTMLAnchorElement.click');
    restorers.push(() => {
      if (anchorProto.click === hookedAnchorClick) anchorProto.click = origAnchorClick;
    });
  }

  // ── history.pushState / replaceState (SPA route changes) ────────────
  const hist = w.history;
  if (hist) {
    for (const name of ['pushState', 'replaceState'] as const) {
      const orig = hist[name];
      if (typeof orig !== 'function') continue;
      const hooked = function (this: unknown, ...args: any[]) {
        const d = args[2] !== undefined && args[2] !== null ? describeUrl(args[2]) : { url: '(unchanged)' };
        emit({ kind: `history-${name}`, url: d.url, queryKeys: (d as { queryKeys?: string[] }).queryKeys });
        return Reflect.apply(orig, this ?? hist, args);
      };
      hist[name] = hooked;
      restorers.push(() => {
        if (hist[name] === hooked) hist[name] = orig;
      });
    }
    hooks.push('history');
  }

  // ── cleanup ─────────────────────────────────────────────────────────
  let cleaned = false;
  const cleanup = (reason: string): void => {
    if (cleaned) return;
    cleaned = true;
    for (const restore of restorers.reverse()) {
      try {
        restore();
      } catch {
        // ignore
      }
    }
    try {
      doc.removeEventListener(cleanupEventName, onCleanupEvent);
    } catch {
      // ignore
    }
    clearTimeout(timer);
    try {
      if (w[FLAG] && w[FLAG].cleanup === cleanup) delete w[FLAG];
    } catch {
      // ignore
    }
    emit({ kind: 'cleanup', reason });
  };
  // Declared before any path can call cleanup(): the listener below is registered afterwards.
  const timer = setTimeout(() => cleanup('auto_timeout'), Math.max(1000, Number(autoCleanupMs) || 0));
  const onCleanupEvent = (): void => cleanup('requested');
  doc.addEventListener(cleanupEventName, onCleanupEvent);
  try {
    Object.defineProperty(w, FLAG, {
      value: { cleanup },
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    // ignore
  }

  emit({ kind: 'ready', hooks });
}
