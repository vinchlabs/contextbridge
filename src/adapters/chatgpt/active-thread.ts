/**
 * ChatGPT's app shell can keep several thread pages mounted at once; inactive pages stay in the
 * DOM hidden under [data-app-shell-active-page="false"] (live diagnostics showed two
 * [data-app-action-timeline-scroll] elements: a hidden one with 0x0 size first in document order,
 * and the real one). Everything the crawler reads must be scoped to the thread on screen,
 * otherwise it scrolls a hidden container and mixes turns from another conversation.
 */

import { CHATGPT_SELECTORS } from './selectors';

export const INACTIVE_PAGE_SELECTOR = '[data-app-shell-active-page="false"]';
const TIMELINE_SELECTOR = '[data-app-action-timeline-scroll]';

/** True when the document has a real layout engine (false in DOM emulators such as happy-dom). */
export function hasLayout(doc: Document): boolean {
  const html = doc.documentElement as HTMLElement | null;
  return Boolean(html && (html.clientHeight > 0 || html.clientWidth > 0));
}

export function isInInactivePage(el: Element): boolean {
  return Boolean(el.closest?.(INACTIVE_PAGE_SELECTOR));
}

/** Has a box (not display:none / detached). Only meaningful when hasLayout() is true. */
export function isRendered(el: Element): boolean {
  const h = el as HTMLElement;
  if (h.clientHeight > 0 || h.clientWidth > 0) return true;
  try {
    return h.getClientRects().length > 0;
  } catch {
    return false;
  }
}

/**
 * The timeline scroller of the thread that is actually displayed: outside inactive pages,
 * rendered, preferably containing turns; the largest scrollHeight wins. Without a layout engine
 * (tests) the first scroller outside inactive pages is used.
 */
export function findActiveTimelineScroller(doc: Document): HTMLElement | null {
  const all = Array.from(doc.querySelectorAll<HTMLElement>(TIMELINE_SELECTOR));
  if (all.length === 0) return null;
  const outsideInactive = all.filter((el) => !isInInactivePage(el));
  const pool = outsideInactive.length > 0 ? outsideInactive : all;
  const withTurns = pool.filter((el) => el.querySelector(CHATGPT_SELECTORS.TURNS.PRIMARY));
  const candidates = withTurns.length > 0 ? withTurns : pool;
  if (hasLayout(doc)) {
    const rendered = candidates.filter(isRendered);
    if (rendered.length > 0) {
      return rendered.reduce((best, el) => (el.scrollHeight > best.scrollHeight ? el : best));
    }
  }
  return candidates[0] ?? null;
}

/** Root for all turn/unit queries: the active timeline scroller, else the whole document. */
export function findActiveThreadRoot(doc: Document): Document | HTMLElement {
  return findActiveTimelineScroller(doc) ?? doc;
}

/** querySelectorAll scoped to the active thread, never returning nodes from inactive pages. */
export function queryActiveThread(root: Document | HTMLElement, selector: string): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((el) => !isInInactivePage(el));
}

/** Conversation id from the page URL (/c/<id>, also /g/<gizmo>/c/<id>); DOM ids can belong to hidden pages. */
export function conversationIdFromUrl(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  try {
    const match = new URL(href).pathname.match(/\/c\/([A-Za-z0-9-]{8,})/);
    return match?.[1];
  } catch {
    return undefined;
  }
}
