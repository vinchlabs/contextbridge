/**
 * MAIN-world hooks that capture ChatGPT uploaded-file bytes through the page's own resolution
 * chain, exactly as the resource-card probe observed it on a live chat:
 *   1. GET /backend-api/files/{file_id}/simple   -> { file_id, file_name, mime_type, ... }
 *   2. GET /backend-api/files/download/{file_id} -> { status, download_url, file_name, file_size_bytes, ... }
 *   3. GET <download_url> (/backend-api/estuary/content?id=...&sig=...) -> the file bytes
 * Responses the page requests itself are cloned. Step 3 is only repeated by us (command
 * 'fetch-content') with the exact download_url ChatGPT returned, never with a constructed URL.
 *
 * When ChatGPT answers a card from its own cache (only step 1 goes over the network), command
 * 'fetch-download' repeats step 2 for that file id the way the page itself sends it: the URL
 * template and request headers are copied from ChatGPT's own files/download (or files/simple)
 * request seen earlier in this session. Those headers stay inside this closure; they are never
 * put into an event.
 *
 * Capturing only happens while "armed" (one card activation at a time). While armed,
 * window.open and programmatic download/navigation anchor clicks are suppressed so activating a
 * card cannot open a tab or start a download.
 *
 * Self-contained: serialized into the page by scripting.executeScript (or an inline <script>).
 * Signed URLs and bytes only travel through these in-memory events and are never persisted.
 */

export const FILE_CAPTURE_EVENT_PREFIX = 'ctxbridge-filecap-event-';
export const FILE_CAPTURE_COMMAND_PREFIX = 'ctxbridge-filecap-cmd-';

export interface FileCaptureInstallArgs {
  eventName: string;
  commandEventName: string;
  autoCleanupMs: number;
  maxBytes: number;
}

export function fileCaptureArgsList(args: FileCaptureInstallArgs): [string, string, number, number] {
  return [args.eventName, args.commandEventName, args.autoCleanupMs, args.maxBytes];
}

export function installFileCaptureHooks(
  eventName: string,
  commandEventName: string,
  autoCleanupMs: number,
  maxBytes: number
): void {
  const w = window as any;
  const doc = document;
  const FLAG = '__ctxbridgeFileCapture';
  const ESTUARY_PATH = '/backend-api/estuary/content';
  const DOWNLOAD_RE = /^\/backend-api\/files\/download\/([^/?#]+)/;
  const SIMPLE_RE = /^\/backend-api\/files\/([^/?#]+)\/simple$/;
  const FILE_ID_RE = /^file[-_][A-Za-z0-9]{8,64}$/;
  const SKIP_HEADER_RE = /^(content-length|content-type|cookie|host|connection|accept-encoding)$/i;

  try {
    if (w[FLAG] && typeof w[FLAG].cleanup === 'function') w[FLAG].cleanup('superseded');
  } catch {
    // ignore
  }

  let armed = false;
  const emit = (evt: Record<string, unknown>): void => {
    try {
      evt.t = Date.now();
      doc.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(evt) }));
    } catch {
      // ignore
    }
  };

  const parse = (raw: unknown): URL | null => {
    try {
      return new URL(String(raw ?? ''), location.href);
    } catch {
      return null;
    }
  };

  const isContentUrl = (u: URL): boolean =>
    (u.origin === location.origin && u.pathname === ESTUARY_PATH) || /(^|\.)oaiusercontent\.com$/i.test(u.hostname);

  const toBase64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };

  // What ChatGPT's own file requests looked like in this session (for 'fetch-download').
  let downloadTemplate: { search: string; headers: Array<[string, string]> } | null = null;
  let simpleHeaders: Array<[string, string]> | null = null;
  let lastConversationId: string | null = null;

  const headerPairs = (args: any[]): Array<[string, string]> | null => {
    try {
      const input = args[0];
      const init = args[1];
      const source =
        init && init.headers ? init.headers : input && typeof input === 'object' && input.headers ? input.headers : null;
      if (!source) return null;
      const out: Array<[string, string]> = [];
      new Headers(source).forEach((value: string, key: string) => {
        if (!SKIP_HEADER_RE.test(key)) out.push([key, value]);
      });
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };

  /** Same headers the page sent, with the per-endpoint routing headers adjusted to `path`. */
  const replayHeaders = (pairs: Array<[string, string]>, path: string, sameRoute: boolean): Headers => {
    const h = new Headers();
    for (const [key, value] of pairs) {
      const lower = key.toLowerCase();
      try {
        if (lower === 'x-openai-target-path') h.set(key, path);
        else if (lower === 'x-openai-target-route') {
          if (sameRoute) h.set(key, value);
        } else h.set(key, value);
      } catch {
        // header the browser refuses to set from script
      }
    }
    return h;
  };

  const conversationIdOf = (u: URL): string | null =>
    u.searchParams.get('conversation_id') || u.searchParams.get('check_context_scopes_for_conversation_id');

  const restorers: Array<() => void> = [];

  // ── fetch: observe the page's own file-resolution requests ──────────
  const origFetch = w.fetch;
  if (typeof origFetch === 'function') {
    const hookedFetch = function (this: unknown, ...args: any[]) {
      const promise: any = Reflect.apply(origFetch, this ?? w, args);
      if (!armed) return promise;
      let rawUrl: unknown = '';
      try {
        const input = args[0];
        rawUrl = typeof input === 'string' ? input : (input?.url ?? input?.href ?? String(input));
      } catch {
        // ignore
      }
      const u = parse(rawUrl);
      if (!u) return promise;
      const download = u.origin === location.origin ? u.pathname.match(DOWNLOAD_RE) : null;
      const simple = u.origin === location.origin ? u.pathname.match(SIMPLE_RE) : null;
      const content = isContentUrl(u);
      if (!download && !simple && !content) return promise;

      if (download || simple) {
        // A page that authenticates with cookies only sends no extra headers; that is recorded too.
        const pairs = headerPairs(args) ?? [];
        if (download) downloadTemplate = { search: u.search, headers: pairs };
        else simpleHeaders = pairs;
        lastConversationId = conversationIdOf(u) || lastConversationId;
      }

      try {
        promise.then(
          (res: any) => {
            try {
              if (download || simple) {
                res
                  .clone()
                  .json()
                  .then(
                    (json: any) => {
                      if (download) {
                        emit({
                          kind: 'download-info',
                          fileId: decodeURIComponent(download[1]!),
                          httpStatus: res.status,
                          status: typeof json?.status === 'string' ? json.status : undefined,
                          downloadUrl: typeof json?.download_url === 'string' ? json.download_url : undefined,
                          fileName: typeof json?.file_name === 'string' ? json.file_name : undefined,
                          fileSizeBytes: typeof json?.file_size_bytes === 'number' ? json.file_size_bytes : undefined,
                          mimeType: typeof json?.mime_type === 'string' ? json.mime_type : undefined,
                          errorCode:
                            typeof json?.error_code === 'string'
                              ? json.error_code
                              : typeof json?.detail === 'string'
                                ? json.detail.slice(0, 120)
                                : undefined,
                        });
                      } else {
                        emit({
                          kind: 'file-meta',
                          fileId: decodeURIComponent(simple![1]!),
                          httpStatus: res.status,
                          fileName: typeof json?.file_name === 'string' ? json.file_name : undefined,
                          mimeType: typeof json?.mime_type === 'string' ? json.mime_type : undefined,
                        });
                      }
                    },
                    () => emit({ kind: download ? 'download-info' : 'file-meta', httpStatus: res.status, parseError: true })
                  );
                return;
              }
              const declared = Number(res.headers.get('content-length') || 0);
              if (!res.ok || declared > maxBytes) {
                emit({
                  kind: 'content-skipped',
                  url: u.href,
                  httpStatus: res.status,
                  reason: res.ok ? 'too_large' : 'http_error',
                  size: declared || undefined,
                });
                return;
              }
              res
                .clone()
                .arrayBuffer()
                .then(
                  (buf: ArrayBuffer) => {
                    if (buf.byteLength > maxBytes) {
                      emit({ kind: 'content-skipped', url: u.href, reason: 'too_large', size: buf.byteLength });
                      return;
                    }
                    emit({
                      kind: 'content-bytes',
                      url: u.href,
                      contentId: u.searchParams.get('id') || undefined,
                      httpStatus: res.status,
                      contentType: res.headers.get('content-type') || undefined,
                      contentDisposition: res.headers.get('content-disposition') || undefined,
                      size: buf.byteLength,
                      base64: toBase64(buf),
                    });
                  },
                  () => emit({ kind: 'content-skipped', url: u.href, reason: 'read_failed' })
                );
            } catch {
              // ignore
            }
          },
          () => {
            // network failure is reported by the page itself
          }
        );
      } catch {
        // ignore
      }
      return promise;
    };
    w.fetch = hookedFetch;
    restorers.push(() => {
      if (w.fetch === hookedFetch) w.fetch = origFetch;
    });
  }

  // ── no tabs / downloads while a card is being activated ─────────────
  const origOpen = w.open;
  if (typeof origOpen === 'function') {
    const hookedOpen = function (this: unknown, ...args: any[]) {
      if (armed) {
        const u = parse(args[0]);
        emit({ kind: 'download-link', via: 'window.open', url: u && isContentUrl(u) ? u.href : undefined });
        return null;
      }
      return Reflect.apply(origOpen, this ?? w, args);
    };
    w.open = hookedOpen;
    restorers.push(() => {
      if (w.open === hookedOpen) w.open = origOpen;
    });
  }
  const anchorProto = w.HTMLAnchorElement?.prototype;
  if (anchorProto && typeof anchorProto.click === 'function') {
    const origClick = anchorProto.click;
    const hookedClick = function (this: any, ...args: any[]) {
      if (armed) {
        try {
          const href = String(this.getAttribute('href') || '');
          const navigates = href !== '' && !href.startsWith('#') && !/^javascript:/i.test(href);
          if (this.hasAttribute('download') || navigates) {
            const u = parse(this.href || href);
            emit({ kind: 'download-link', via: 'anchor', url: u && isContentUrl(u) ? u.href : undefined });
            return undefined;
          }
        } catch {
          // ignore
        }
      }
      return Reflect.apply(origClick, this, args);
    };
    anchorProto.click = hookedClick;
    restorers.push(() => {
      if (anchorProto.click === hookedClick) anchorProto.click = origClick;
    });
  }

  // ── commands from the content script ─────────────────────────────────
  let cleaned = false;
  const cleanup = (reason: string): void => {
    if (cleaned) return;
    cleaned = true;
    armed = false;
    for (const restore of restorers.reverse()) {
      try {
        restore();
      } catch {
        // ignore
      }
    }
    try {
      doc.removeEventListener(commandEventName, onCommand);
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

  const onCommand = (event: Event): void => {
    let cmd: any;
    try {
      cmd = JSON.parse(String((event as CustomEvent).detail));
    } catch {
      return;
    }
    if (!cmd || typeof cmd.op !== 'string') return;
    if (cmd.op === 'arm') {
      armed = true;
      return;
    }
    if (cmd.op === 'disarm') {
      armed = false;
      return;
    }
    if (cmd.op === 'cleanup') {
      cleanup('requested');
      return;
    }
    if (cmd.op === 'fetch-content') {
      const requestId = String(cmd.requestId || '');
      const u = parse(cmd.url);
      if (!u || !isContentUrl(u)) {
        emit({ kind: 'fetch-result', requestId, ok: false, error: 'url_not_allowed' });
        return;
      }
      Promise.resolve()
        .then(() =>
          Reflect.apply(origFetch, w, [u.href, { credentials: u.origin === location.origin ? 'include' : 'omit' }])
        )
        .then((res: any) => {
          if (!res.ok) {
            emit({ kind: 'fetch-result', requestId, ok: false, httpStatus: res.status, error: 'http_error' });
            return undefined;
          }
          return res.arrayBuffer().then((buf: ArrayBuffer) => {
            if (buf.byteLength > maxBytes) {
              emit({ kind: 'fetch-result', requestId, ok: false, error: 'too_large', size: buf.byteLength });
              return;
            }
            emit({
              kind: 'fetch-result',
              requestId,
              ok: true,
              httpStatus: res.status,
              contentType: res.headers.get('content-type') || undefined,
              contentDisposition: res.headers.get('content-disposition') || undefined,
              size: buf.byteLength,
              base64: toBase64(buf),
            });
          });
        })
        .catch((err: any) => emit({ kind: 'fetch-result', requestId, ok: false, error: String(err?.name || err) }));
      return;
    }
    if (cmd.op === 'fetch-download') {
      const requestId = String(cmd.requestId || '');
      const fileId = String(cmd.fileId || '');
      const fail = (error: string, extra: Record<string, unknown> = {}) =>
        emit({ kind: 'fetch-result', requestId, ok: false, error, ...extra });
      if (!FILE_ID_RE.test(fileId)) {
        fail('file_id_not_allowed');
        return;
      }
      const template = downloadTemplate;
      const pairs = template ? template.headers : simpleHeaders;
      if (!pairs) {
        // Never send a request the page itself has not made in this session.
        fail('no_page_request_seen');
        return;
      }
      const path = `/backend-api/files/download/${encodeURIComponent(fileId)}`;
      let search = '';
      let replaySource = 'fallback-query';
      if (template) {
        search = template.search;
        replaySource = 'page-template';
      } else {
        const fromPath = location.pathname.match(/\/c\/([0-9A-Za-z-]{16,})/);
        const cid = lastConversationId || (fromPath ? fromPath[1] : null);
        search = cid ? `?check_context_scopes_for_conversation_id=${encodeURIComponent(cid)}` : '';
      }
      Promise.resolve()
        .then(() =>
          Reflect.apply(origFetch, w, [
            location.origin + path + search,
            { credentials: 'include', headers: replayHeaders(pairs, path, Boolean(template)) },
          ])
        )
        .then((res: any) =>
          res.json().then(
            (json: any) => ({ res, json }),
            () => ({ res, json: null })
          )
        )
        .then(({ res, json }: { res: any; json: any }) => {
          const info: Record<string, unknown> = {
            replaySource,
            downloadHttpStatus: res.status,
            downloadStatus: typeof json?.status === 'string' ? json.status : undefined,
            fileName: typeof json?.file_name === 'string' ? json.file_name : undefined,
            fileSizeBytes: typeof json?.file_size_bytes === 'number' ? json.file_size_bytes : undefined,
            mimeType: typeof json?.mime_type === 'string' ? json.mime_type : undefined,
          };
          if (!res.ok) {
            fail(`download_http_${res.status}`, info);
            return undefined;
          }
          if (info.downloadStatus && info.downloadStatus !== 'success') {
            fail(`download_status_${String(info.downloadStatus)}`, info);
            return undefined;
          }
          const u = parse(json?.download_url);
          if (!u || !isContentUrl(u)) {
            fail(u ? 'download_url_not_allowed' : 'download_url_missing', info);
            return undefined;
          }
          const sameOrigin = u.origin === location.origin;
          const getContent = (withHeaders: boolean): Promise<any> =>
            Reflect.apply(origFetch, w, [
              u.href,
              !sameOrigin
                ? { credentials: 'omit' }
                : withHeaders
                  ? { credentials: 'include', headers: replayHeaders(pairs, u.pathname, false) }
                  : { credentials: 'include' },
            ]) as Promise<any>;
          // A signed download_url normally needs nothing but the session (the page loads it like an
          // image); only a same-origin 401/403 is retried with the page's own request headers.
          return getContent(false)
            .then((res: any) => (sameOrigin && (res.status === 401 || res.status === 403) ? getContent(true) : res))
            .then((contentRes: any) => {
              if (!contentRes.ok) {
                fail(`content_http_${contentRes.status}`, { ...info, httpStatus: contentRes.status });
                return undefined;
              }
              const declared = Number(contentRes.headers.get('content-length') || 0);
              if (declared > maxBytes) {
                fail('too_large', { ...info, size: declared });
                return undefined;
              }
              return contentRes.arrayBuffer().then((buf: ArrayBuffer) => {
                if (buf.byteLength > maxBytes) {
                  fail('too_large', { ...info, size: buf.byteLength });
                  return;
                }
                emit({
                  kind: 'fetch-result',
                  requestId,
                  ok: true,
                  ...info,
                  httpStatus: contentRes.status,
                  contentType: contentRes.headers.get('content-type') || undefined,
                  contentDisposition: contentRes.headers.get('content-disposition') || undefined,
                  size: buf.byteLength,
                  base64: toBase64(buf),
                });
              });
            });
        })
        .catch((err: any) => fail(String(err?.name || err)));
    }
  };

  const timer = setTimeout(() => cleanup('auto_timeout'), Math.max(5000, Number(autoCleanupMs) || 0));
  doc.addEventListener(commandEventName, onCommand);
  try {
    Object.defineProperty(w, FLAG, { value: { cleanup }, configurable: true, enumerable: false, writable: true });
  } catch {
    // ignore
  }
  emit({ kind: 'ready', hooks: ['fetch', 'window.open', 'HTMLAnchorElement.click'] });
}
