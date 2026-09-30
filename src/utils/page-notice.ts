/**
 * Small notice shown inside the chat page after ContextBridge adds a conversation to the
 * message box (or fails to). The popup is usually closed by then, so this is where the user
 * learns what happened and what to do next.
 *
 * Rendered in a closed shadow root with CSSOM inline styles only: page CSS cannot restyle it and
 * a strict page CSP (style-src) cannot block it. All text goes through textContent.
 */

export type NoticeTone = 'ok' | 'warn' | 'error';

export interface PageNoticeOptions {
  tone: NoticeTone;
  title: string;
  lines?: string[];
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  autoHideMs?: number;
}

const HOST_ID = 'contextbridge-page-notice';

type Styles = Partial<Record<string, string>>;

function applyStyles(el: HTMLElement, styles: Styles): void {
  for (const [prop, value] of Object.entries(styles)) {
    if (value !== undefined) el.style.setProperty(prop, value);
  }
}

interface Palette {
  bg: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
}

function palette(win: Window | null, tone: NoticeTone): Palette {
  let dark = false;
  try {
    dark = !!win?.matchMedia?.('(prefers-color-scheme: dark)').matches;
  } catch {
    dark = false;
  }
  // Same values as the popup theme (entrypoints/popup/style.css).
  const accent = {
    ok: dark ? '#86d6ae' : '#1d6b4b',
    warn: dark ? '#e4b85e' : '#7f5100',
    error: dark ? '#f2968c' : '#b3261e',
  }[tone];
  return dark
    ? { bg: '#1d201e', fg: '#eceeed', muted: '#b2b9b5', border: '#383e3a', accent }
    : { bg: '#fcfcfb', fg: '#1b1e1c', muted: '#4f5752', border: '#d6dad7', accent };
}

export function dismissPageNotice(doc: Document): void {
  doc.getElementById(HOST_ID)?.remove();
}

export function showPageNotice(doc: Document, options: PageNoticeOptions): () => void {
  const noop = () => undefined;
  try {
    dismissPageNotice(doc);
    const colors = palette(doc.defaultView, options.tone);

    const host = doc.createElement('div');
    host.id = HOST_ID;
    applyStyles(host, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      'z-index': '2147483647',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      width: 'auto',
      height: 'auto',
    });
    const root: ShadowRoot | HTMLElement =
      typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;

    const box = doc.createElement('div');
    box.setAttribute('role', options.tone === 'error' ? 'alert' : 'status');
    box.setAttribute('aria-live', options.tone === 'error' ? 'assertive' : 'polite');
    applyStyles(box, {
      'box-sizing': 'border-box',
      width: '340px',
      'max-width': 'calc(100vw - 32px)',
      background: colors.bg,
      color: colors.fg,
      border: `1px solid ${colors.border}`,
      'border-left': `3px solid ${colors.accent}`,
      'border-radius': '6px',
      padding: '12px 14px 12px 12px',
      'box-shadow': '0 6px 20px rgba(20, 24, 22, 0.18)',
      'font-family': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      'font-size': '13px',
      'line-height': '1.45',
      'text-align': 'left',
    });

    const head = doc.createElement('div');
    applyStyles(head, { display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '8px' });

    const brand = doc.createElement('span');
    brand.textContent = 'ContextBridge';
    applyStyles(brand, { color: colors.muted, 'font-size': '11px', 'font-weight': '600', 'letter-spacing': '0.02em' });

    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', 'Dismiss');
    applyStyles(close, {
      background: 'transparent',
      border: '0',
      color: colors.muted,
      cursor: 'pointer',
      'font-size': '18px',
      'line-height': '1',
      padding: '0 2px',
      margin: '0',
    });

    head.append(brand, close);

    const title = doc.createElement('p');
    title.textContent = options.title;
    applyStyles(title, { margin: '4px 0 0', 'font-size': '14px', 'font-weight': '600', color: colors.fg });

    box.append(head, title);
    for (const line of options.lines ?? []) {
      if (!line) continue;
      const p = doc.createElement('p');
      p.textContent = line;
      applyStyles(p, { margin: '6px 0 0', color: colors.fg, 'overflow-wrap': 'anywhere' });
      box.append(p);
    }

    root.appendChild(box);
    (doc.body || doc.documentElement).appendChild(host);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      host.remove();
    };
    const arm = () => {
      if (options.autoHideMs && options.autoHideMs > 0) timer = setTimeout(dismiss, options.autoHideMs);
    };
    close.addEventListener('click', dismiss);
    box.addEventListener('mouseenter', () => {
      if (timer) clearTimeout(timer);
    });
    box.addEventListener('mouseleave', arm);
    arm();
    return dismiss;
  } catch {
    return noop;
  }
}
