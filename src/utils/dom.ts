/**
 * DOM and event manipulation utilities for extension content scripts
 */

/**
 * Finds the main scrollable container on the page.
 */
export function findScrollContainer(doc: Document = document, preferredSelectors: string[] = []): HTMLElement {
  // Check preferred selectors first
  for (const sel of preferredSelectors) {
    const el = doc.querySelector(sel);
    if (el && ('scrollHeight' in el) && isScrollable(el as HTMLElement)) {
      return el as HTMLElement;
    }
  }

  // Common main containers
  const candidates = [
    doc.querySelector('main'),
    doc.querySelector('[role="main"]'),
    doc.querySelector('[class*="scroll"]'),
    doc.querySelector('[data-scroll-container]'),
    doc.scrollingElement as HTMLElement,
    doc.documentElement,
    doc.body,
  ];

  for (const el of candidates) {
    if (el && ('scrollHeight' in el) && isScrollable(el as HTMLElement)) {
      return el as HTMLElement;
    }
  }

  return (doc.scrollingElement as HTMLElement) || doc.documentElement || doc.body;
}

/**
 * Drops elements that are contained in another element of the same list, so a selector that
 * matches both a wrapper and its inner element yields one entry (document order preserved).
 */
export function outermostElements<T extends Element>(elements: T[]): T[] {
  const set = new Set<Element>(elements);
  return elements.filter((el) => {
    let cur = el.parentElement;
    while (cur) {
      if (set.has(cur)) return false;
      cur = cur.parentElement;
    }
    return true;
  });
}

/** querySelectorAll(selector) restricted to matches with no matching ancestor inside root. */
export function topLevelMatches(root: Element, selector: string): Element[] {
  return outermostElements(Array.from(root.querySelectorAll(selector)));
}

/**
 * Stable, content-derived fingerprint (FNV-1a over normalized text + length). Used as a message
 * identity when the provider exposes no id attribute, so re-scans after scrolling dedupe
 * correctly instead of relying on the (shifting) DOM position.
 */
export function contentFingerprint(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  let hash = 0x811c9dc5;
  const limit = Math.min(normalized.length, 8000);
  for (let i = 0; i < limit; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${normalized.length.toString(36)}`;
}

export function isScrollable(el: HTMLElement): boolean {
  if (!el) return false;
  const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (!style) return el.scrollHeight > el.clientHeight;

  const overflowY = style.overflowY;
  const isOverflow = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  return isOverflow && el.scrollHeight > el.clientHeight;
}

/**
 * Dispatches simulated user typing events to update React/ProseMirror controlled inputs.
 */
export function dispatchInputEvents(element: HTMLElement, text: string): void {
  element.focus?.();

  const isTextArea =
    (typeof HTMLTextAreaElement !== 'undefined' && element instanceof HTMLTextAreaElement) ||
    element.tagName === 'TEXTAREA';
  const isInput =
    (typeof HTMLInputElement !== 'undefined' && element instanceof HTMLInputElement) ||
    element.tagName === 'INPUT';

  if (isTextArea || isInput) {
    (element as HTMLInputElement | HTMLTextAreaElement).value = text;
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } else if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') {
    // For contenteditable / ProseMirror / Lexical
    element.textContent = text;
    if (typeof InputEvent !== 'undefined') {
      element.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    } else {
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } else {
    element.textContent = text;
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  }
}

/**
 * Attaches files to an HTML file input element using DataTransfer.
 */
export function attachFilesToFileInput(
  fileInput: HTMLInputElement,
  files: { filename: string; data: Uint8Array; mimeType: string }[]
): boolean {
  try {
    const dt = new DataTransfer();
    for (const f of files) {
      const file = new File([f.data as any], f.filename, { type: f.mimeType });
      dt.items.add(file);
    }
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    fileInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    return true;
  } catch (err) {
    console.warn('[ContextBridge] Failed to set fileInput.files via DataTransfer:', err);
    return false;
  }
}

/**
 * Extracts table data from a <table> DOM element.
 */
export function extractTableData(tableEl: HTMLTableElement | Element): { headers: string[]; rows: string[][] } {
  const headers: string[] = [];
  const rows: string[][] = [];

  const thElements = tableEl.querySelectorAll('thead th, tr:first-child th');
  thElements.forEach((th) => {
    headers.push(th.textContent?.trim() || '');
  });

  const trElements = tableEl.querySelectorAll('tbody tr, tr');
  trElements.forEach((tr, index) => {
    // If first row was used as header, skip it
    if (index === 0 && thElements.length > 0 && tr.querySelector('th')) {
      return;
    }
    const row: string[] = [];
    const cells = tr.querySelectorAll('td, th');
    cells.forEach((cell) => {
      row.push(cell.textContent?.trim() || '');
    });
    if (row.length > 0) {
      rows.push(row);
    }
  });

  return { headers, rows };
}
