/**
 * Reads a picture, video or file the way the chat page itself can. The background runs this in
 * the page's MAIN world (scripting.executeScript), so it must stay self-contained: the function
 * is serialized from its source text and may not use imports or anything outside its body.
 *
 * Why: Firefox keeps a site's session out of the extension's own requests (cookies are kept per
 * site), content scripts may not load the page's blob: URLs, and a canvas is "tainted" by
 * pictures from other origins. The page has what is missing: its fetch() carries its session,
 * Google's image hosts allow its origin through CORS, and pictures from its own blob: URLs are
 * readable. Everything stays under the page's own rules (CORS, CSP), so this reads nothing the
 * page could not read itself. Only the background calls this, for URLs isPageFetchAllowed
 * accepted, and it checks the final URL again. Bytes go back as base64 in memory only.
 *
 * Order:
 *   1. A blob: picture the page shows: its pixels. No network, and Gemini's CSP (connect-src
 *      without blob:) forbids fetching blob: URLs anyway.
 *   2. fetch() with the page's session, then without (hosts answering "*" refuse cookies).
 *   3. Pictures only: the URL again as a CORS image (Google's hosts allow the page's origin).
 *   4. Pictures only: the picture the page shows, when the page may read it.
 * Pixels come back as PNG; fetch() returns the original file.
 */

export interface PageFetchResult {
  ok: boolean;
  base64?: string;
  contentType?: string;
  /** Address after redirects. */
  finalUrl?: string;
  status?: number;
  /** 'fetch': the original file. 'canvas': the picture's pixels as PNG. */
  via?: 'fetch' | 'canvas';
  error?: string;
}

export async function pageFetchMedia(
  url: string,
  expectedOrigin: string,
  maxBytes: number,
  isPicture: boolean
): Promise<PageFetchResult> {
  const notes: string[] = [];
  const blockedBy: string[] = [];
  const text = (err: unknown): string => {
    const e = err as { name?: unknown; message?: unknown } | null;
    const name = typeof e?.name === 'string' ? `${e.name}: ` : '';
    return `${name}${String(e?.message ?? err)}`.slice(0, 120);
  };
  const onViolation = (event: SecurityPolicyViolationEvent): void => {
    blockedBy.push(event.effectiveDirective || event.violatedDirective || 'csp');
  };
  const toBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma === -1) reject(new Error('unreadable data URL'));
        else resolve(dataUrl.slice(comma + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  // The pixels of a picture the page may read (same-origin, or loaded with CORS approval).
  // Any other picture taints the canvas and toBlob throws a SecurityError.
  const pixels = async (img: HTMLImageElement): Promise<PageFetchResult | null> => {
    if (!img.complete || !img.naturalWidth || !img.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(img, 0, 0);
    const png = await new Promise<Blob | null>((resolve, reject) => {
      try {
        canvas.toBlob(resolve, 'image/png');
      } catch (err) {
        reject(err);
      }
    });
    if (!png || png.size === 0) return null;
    if (png.size > maxBytes) return { ok: false, error: 'too_large' };
    return { ok: true, base64: await toBase64(png), contentType: 'image/png', finalUrl: url, via: 'canvas' };
  };
  const fromShownPicture = async (): Promise<PageFetchResult | null> => {
    const shown = Array.from(document.querySelectorAll('img')).filter(
      (img) => img.currentSrc === url || img.getAttribute('src') === url
    );
    if (shown.length === 0) notes.push('shown: not on the page');
    for (const img of shown) {
      try {
        const result = await pixels(img);
        if (result) return result;
        notes.push('shown: not loaded');
      } catch (err) {
        notes.push(`shown: ${text(err)}`);
      }
    }
    return null;
  };
  const loadPicture = (crossOrigin: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = crossOrigin;
      const timer = setTimeout(() => reject(new Error('timed out')), 20_000);
      img.onload = () => {
        clearTimeout(timer);
        resolve(img);
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('did not load'));
      };
      img.src = url;
    });

  document.addEventListener('securitypolicyviolation', onViolation);
  try {
    // The tab may have moved to another site since the content script asked.
    if (location.origin !== expectedOrigin) return { ok: false, error: 'page_changed' };
    const isBlob = url.startsWith('blob:');

    if (isBlob && isPicture) {
      const shown = await fromShownPicture();
      if (shown) return shown;
    }

    let response: Response | null = null;
    let status: number | undefined;
    for (const credentials of ['include', 'omit'] as const) {
      try {
        const attempt = await fetch(url, { credentials, redirect: 'follow' });
        if (attempt.ok) {
          response = attempt;
          break;
        }
        status = attempt.status;
        notes.push(`fetch(${credentials}): HTTP ${attempt.status}`);
      } catch (err) {
        // CORS, CSP or network error: try the next mode.
        notes.push(`fetch(${credentials}): ${text(err)}`);
      }
    }

    if (response) {
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, error: 'too_large' };
      const chunks: BlobPart[] = [];
      let total = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, error: 'too_large' };
          }
          chunks.push(value as BlobPart);
        }
      } else {
        const whole = await response.arrayBuffer();
        total = whole.byteLength;
        if (total > maxBytes) return { ok: false, error: 'too_large' };
        chunks.push(whole);
      }
      if (total > 0) {
        return {
          ok: true,
          base64: await toBase64(new Blob(chunks)),
          contentType: response.headers.get('content-type') || '',
          finalUrl: response.url || url,
          via: 'fetch',
        };
      }
      notes.push('fetch: empty');
    }

    if (isPicture) {
      for (const crossOrigin of ['use-credentials', 'anonymous']) {
        try {
          const result = await pixels(await loadPicture(crossOrigin));
          if (result) return result;
          notes.push(`image(${crossOrigin}): empty`);
        } catch (err) {
          notes.push(`image(${crossOrigin}): ${text(err)}`);
        }
      }
      if (!isBlob) {
        const shown = await fromShownPicture();
        if (shown) return shown;
      }
    }

    // Violation events arrive as a separate task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (blockedBy.length > 0) notes.push(`blocked by CSP ${Array.from(new Set(blockedBy)).join(',')}`);
    return { ok: false, status, error: notes.join('; ').slice(0, 400) || 'page_fetch_failed' };
  } catch (err) {
    return { ok: false, error: `page_fetch_failed: ${text(err)}` };
  } finally {
    document.removeEventListener('securitypolicyviolation', onViolation);
  }
}
