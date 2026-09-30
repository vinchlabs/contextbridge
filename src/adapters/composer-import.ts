/**
 * Shared "continue in target AI" delivery: finds the target composer, inserts the handoff prompt
 * in a way rich editors (ProseMirror / Quill / Lexical / React textareas) actually register,
 * verifies the text landed, then hands the files over and checks that the page shows them.
 *
 * Files are offered the way a person would (upload input, paste, drop), one way at a time, and a
 * way counts only when the page then shows the files (a chip with the file name or a preview
 * picture). Anything the page did not show is reported, never claimed as attached.
 */

import type { PreparedHandoff, PreparedHandoffFile } from '../core/handoff/strategies';
import type { PlatformId } from '../core/model/canonical';
import { platformInfo } from '../core/platforms';
import type { ImportResult } from './adapter';
import { fromWireBytes } from '../utils/wire-bytes';

export interface ComposerTargetConfig {
  platform: PlatformId;
  displayName: string;
  /** Checked one by one, in priority order (not document order). */
  composerSelectors: string[];
  fileInputSelectors: string[];
  composerTimeoutMs?: number;
  /** Most files the site takes in one message. Default: the platform's limit. */
  maxFiles?: number;
  /** How long each way of attaching waits for the page to show the files (ms, default 3000). */
  attachConfirmMs?: number;
  /**
   * How long a way the page reacted to (it cancelled the paste or drop, or emptied its upload
   * input after reading it) may take to show the files before the next way is tried
   * (ms, default 10000). Slow sites then get time instead of a second copy of the files.
   */
  attachPatienceMs?: number;
}

export type AttachMethod = 'file-input' | 'paste' | 'drop';

export interface AttachOutcome {
  /** The way after which the page showed the files; 'none' when it showed none. */
  method: AttachMethod | 'none' | 'unsupported';
  /** Ways that were carried out, in order. */
  tried: AttachMethod[];
  /** File names the page showed. */
  confirmed: string[];
  /** Handed over, the page gave no sign of taking them, and it did not show them. */
  notConfirmed: string[];
  /**
   * Handed over and the page reacted (so they may be there), but it showed none of them in a
   * way ContextBridge recognises. The user should look before sending.
   */
  unverified: string[];
}

/** The page notice ContextBridge itself shows; never evidence of an attachment. */
const OWN_UI_SELECTOR = '#contextbridge-page-notice';
const EDITABLE_SELECTOR =
  'textarea, input, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTextArea(el: Element): el is HTMLTextAreaElement {
  return el.tagName === 'TEXTAREA';
}

function isUsableComposer(el: Element): el is HTMLElement {
  const h = el as HTMLElement;
  if (h.hidden || h.closest?.('[hidden], [aria-hidden="true"]')) return false;
  if (isTextArea(el)) return !el.disabled && !el.readOnly;
  const ce = h.getAttribute('contenteditable');
  return h.isContentEditable === true || ce === 'true' || ce === '' || ce === 'plaintext-only';
}

function findComposer(doc: Document, selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    let matches: Element[] = [];
    try {
      matches = Array.from(doc.querySelectorAll(sel));
    } catch {
      continue;
    }
    const usable = matches.find(isUsableComposer);
    if (usable) return usable as HTMLElement;
  }
  return null;
}

/** SPA composers often mount after 'complete'; poll instead of querying once. */
export async function waitForComposer(
  doc: Document,
  selectors: string[],
  timeoutMs = 10_000
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = findComposer(doc, selectors);
    if (found || Date.now() >= deadline) return found;
    await sleep(200);
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readComposerText(el: HTMLElement): string {
  if (isTextArea(el)) return el.value || '';
  return el.innerText || el.textContent || '';
}

/** True when both the beginning and the end of `expected` are present in the composer. */
function composerContains(el: HTMLElement, expected: string): boolean {
  const want = normalize(expected);
  if (!want) return true;
  const have = normalize(readComposerText(el));
  const head = want.slice(0, 80);
  const tail = want.slice(-80);
  return have.includes(head) && have.includes(tail);
}

function selectAllInside(el: HTMLElement, doc: Document): void {
  if (isTextArea(el)) {
    el.select();
    return;
  }
  const selection = doc.getSelection?.();
  if (!selection) return;
  const range = doc.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

export async function insertTextIntoComposer(
  el: HTMLElement,
  text: string,
  doc: Document = el.ownerDocument
): Promise<{ ok: boolean; method: string }> {
  try {
    el.focus({ preventScroll: true });
  } catch {
    // ignore
  }

  // 1. execCommand('insertText'): a real editing operation, so ProseMirror/Quill/React observe it
  //    exactly like typing (and, unlike a synthetic paste, ChatGPT/Claude do not convert a long
  //    prompt into a "pasted text" attachment). Newlines are preserved as line breaks.
  try {
    if (typeof doc.execCommand === 'function') {
      selectAllInside(el, doc);
      if (doc.execCommand('insertText', false, text)) {
        await sleep(150);
        if (composerContains(el, text)) return { ok: true, method: 'execCommand-insertText' };
      }
    }
  } catch {
    // fall through
  }

  // 2. Structural fallback. One <p> per line keeps line breaks (a bare text node would be
  //    collapsed to a single paragraph by rich editors), then notify the editor.
  try {
    if (isTextArea(el)) {
      el.value = text;
    } else {
      const lines = text.split(/\r?\n/);
      const paragraphs = lines.map((line) => {
        const p = doc.createElement('p');
        if (line) {
          p.textContent = line;
        } else {
          p.appendChild(doc.createElement('br'));
        }
        return p;
      });
      el.replaceChildren(...paragraphs);
    }
    const InputEventCtor = (doc.defaultView as any)?.InputEvent || (globalThis as any).InputEvent;
    el.dispatchEvent(
      typeof InputEventCtor === 'function'
        ? new InputEventCtor('input', { bubbles: true, cancelable: false, inputType: 'insertText' })
        : new Event('input', { bubbles: true })
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    return { ok: composerContains(el, text), method: 'dom-paragraphs' };
  } catch {
    return { ok: false, method: 'failed' };
  }
}

function toBytes(data: unknown): Uint8Array {
  return fromWireBytes(data);
}

function isImageFile(f: PreparedHandoffFile): boolean {
  return /^image\//i.test(f.mimeType || '');
}

function pickFileInput(doc: Document, selectors: string[], files: PreparedHandoffFile[]): HTMLInputElement | null {
  const inputs: HTMLInputElement[] = [];
  for (const sel of selectors) {
    try {
      doc.querySelectorAll<HTMLInputElement>(sel).forEach((i) => {
        if (i.type === 'file' && !i.disabled && !inputs.includes(i)) inputs.push(i);
      });
    } catch {
      // ignore
    }
  }
  // Prefer a general-purpose multi-file input over image-only pickers (accept="image/*,...");
  // an image-only picker is used only when every file is an image.
  const imageOnly = (accept: string) =>
    accept.trim() !== '' && accept.split(',').every((t) => /^\s*image\//i.test(t));
  const general = inputs.filter((i) => !imageOnly(i.accept || ''));
  const picked = general.find((i) => i.multiple) || general[0];
  if (picked) return picked;
  return files.every(isImageFile) ? inputs.find((i) => i.multiple) || inputs[0] || null : null;
}

/**
 * Firefox content scripts see the page through Xray wrappers. A DataTransfer made or filled
 * from the content script keeps the extension as owner of its items, and the page then reads an
 * empty file list. Through wrappedJSObject the objects belong to the page, so the page can read
 * the files. Elsewhere (Chrome, tests) there is no wrappedJSObject and this is a no-op.
 */
function pageView<T>(obj: T): T {
  const waived = (obj as { wrappedJSObject?: T } | null | undefined)?.wrappedJSObject;
  return waived ?? obj;
}

function makeDomFiles(doc: Document, files: PreparedHandoffFile[]): File[] | null {
  const FileCtor = (doc.defaultView as any)?.File || (globalThis as any).File;
  if (typeof FileCtor !== 'function') return null;
  try {
    return files.map(
      (f) => new FileCtor([toBytes(f.data)], f.filename, { type: f.mimeType || 'application/octet-stream' }) as File
    );
  } catch {
    return null;
  }
}

/** A fresh DataTransfer owned by the page, holding `files`; null when the page cannot read it. */
function makePageDataTransfer(doc: Document, files: File[]): DataTransfer | null {
  const win = doc.defaultView as any;
  const Ctor = pageView(win)?.DataTransfer || win?.DataTransfer || (globalThis as any).DataTransfer;
  if (typeof Ctor !== 'function') return null;
  try {
    const dt = new Ctor() as DataTransfer;
    for (const f of files) dt.items.add(f);
    return (dt.files?.length ?? 0) > 0 ? dt : null;
  } catch {
    return null;
  }
}

function placeCaretAtEnd(el: HTMLElement, doc: Document): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    // ignore
  }
  try {
    if (isTextArea(el)) {
      el.setSelectionRange(el.value.length, el.value.length);
      return;
    }
    const selection = doc.getSelection?.();
    if (!selection) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    // ignore
  }
}

interface AttemptRun {
  ok: boolean;
  /** The page took the hand-over (a handler cancelled the event, or it emptied its input). */
  reacted?: () => boolean;
  /** Clears what a failed attempt left behind (e.g. a drop area the site keeps open). */
  undo?: () => void;
}

function tryFileInput(input: HTMLInputElement, doc: Document, files: File[]): AttemptRun {
  const dt = makePageDataTransfer(doc, files);
  if (!dt) return { ok: false };
  try {
    input.files = dt.files;
  } catch {
    return { ok: false };
  }
  if (!input.files || input.files.length === 0) return { ok: false };
  const valueOf = (): string => {
    try {
      return input.value || '';
    } catch {
      return '';
    }
  };
  const valueWithFiles = valueOf();
  // Native order: input, then change.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const changeAccepted = input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return {
    ok: true,
    // Upload handlers usually empty the input once they have read it (so the same file can be
    // picked again).
    reacted: () =>
      !changeAccepted || (input.files?.length ?? 0) === 0 || (valueWithFiles !== '' && valueOf() === ''),
    undo: () => {
      try {
        input.value = '';
      } catch {
        // ignore
      }
    },
  };
}

function tryPaste(composer: HTMLElement, doc: Document, files: File[]): AttemptRun {
  const win = doc.defaultView as any;
  const ClipboardEventCtor = win?.ClipboardEvent || (globalThis as any).ClipboardEvent;
  if (typeof ClipboardEventCtor !== 'function') return { ok: false };
  const dt = makePageDataTransfer(doc, files);
  if (!dt) return { ok: false };
  let evt: ClipboardEvent;
  try {
    evt = new ClipboardEventCtor('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt });
  } catch {
    return { ok: false };
  }
  // Firefox ignores clipboardData in the init dictionary and gives the event its own writable
  // DataTransfer: fill that one, through the page's view of the event.
  try {
    const own = pageView(evt).clipboardData;
    if (!own) {
      Object.defineProperty(evt, 'clipboardData', { value: dt, configurable: true });
    } else if ((own.files?.length ?? 0) < files.length) {
      for (const f of files) own.items.add(f);
    }
  } catch {
    // checked below
  }
  const data = pageView(evt).clipboardData;
  if (!data || (data.files?.length ?? 0) === 0) return { ok: false };
  // Editors paste at the caret and replace a selection: keep the inserted text safe.
  placeCaretAtEnd(composer, doc);
  const accepted = composer.dispatchEvent(evt);
  return { ok: true, reacted: () => !accepted || evt.defaultPrevented };
}

async function tryDrop(composer: HTMLElement, doc: Document, files: File[]): Promise<AttemptRun> {
  const win = doc.defaultView as any;
  const DragEventCtor = win?.DragEvent || (globalThis as any).DragEvent;
  if (typeof DragEventCtor !== 'function') return { ok: false };
  const dt = makePageDataTransfer(doc, files);
  if (!dt) return { ok: false };

  let x = 0;
  let y = 0;
  let hasLayout = false;
  try {
    const rect = composer.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
    hasLayout = rect.width > 0 && rect.height > 0;
  } catch {
    // no layout
  }
  /** Returns false when a handler cancelled the event. */
  const fire = (target: EventTarget, type: string): boolean => {
    const evt = new DragEventCtor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      dataTransfer: dt,
    }) as DragEvent;
    if (!pageView(evt).dataTransfer) {
      try {
        Object.defineProperty(evt, 'dataTransfer', { value: dt, configurable: true });
      } catch {
        // the handler sees no files; the evidence check reports it
      }
    }
    return target.dispatchEvent(evt);
  };

  try {
    placeCaretAtEnd(composer, doc);
    fire(composer, 'dragenter');
    fire(composer, 'dragover');
  } catch {
    return { ok: false };
  }
  // Sites often open a drop area on dragenter and take the drop there, not on the text box.
  await sleep(250);
  let target: Element = composer;
  if (hasLayout) {
    try {
      const hit = doc.elementFromPoint?.(x, y);
      if (hit && typeof hit.dispatchEvent === 'function' && !hit.closest?.(OWN_UI_SELECTOR)) target = hit;
    } catch {
      // keep the composer
    }
  }
  let dropAccepted = true;
  try {
    if (target !== composer && !composer.contains(target)) fire(target, 'dragenter');
    fire(target, 'dragover');
    // Cancelling dragover only means "drops allowed here"; cancelling the drop means it was taken.
    dropAccepted = fire(target, 'drop');
  } catch {
    return { ok: false };
  }
  return {
    ok: true,
    reacted: () => !dropAccepted,
    undo: () => {
      try {
        fire(target, 'dragleave');
        if (target !== composer) fire(composer, 'dragleave');
      } catch {
        // ignore
      }
    },
  };
}

/** Pictures an editor inserted into the text box itself (e.g. Quill's uploader): not wanted. */
function inlinePictures(composer: HTMLElement): Set<Element> {
  return new Set(Array.from(composer.querySelectorAll('img')).filter((img) => /^(blob:|data:)/i.test(img.getAttribute('src') || '')));
}

function hasNewInlinePictures(composer: HTMLElement, before: Set<Element>): boolean {
  for (const img of inlinePictures(composer)) {
    if (!before.has(img)) return true;
  }
  return false;
}

function removeNewInlinePictures(composer: HTMLElement, before: Set<Element>): void {
  for (const img of inlinePictures(composer)) {
    if (!before.has(img)) img.remove();
  }
}

/** Lower-case strings whose appearance in the page means "this file is shown". */
function evidenceKeys(name: string, allNames: string[]): string[] {
  const lower = name.toLowerCase().trim();
  const keys = new Set<string>([lower]);
  const stem = lower.replace(/\.[a-z0-9]{1,10}$/, '');
  if (stem !== lower && stem.length >= 8) keys.add(stem);
  // Chips often shorten long names; a prefix counts only when no other file shares it.
  if (lower.length > 24) {
    const prefix = lower.slice(0, 20);
    const shared = allNames.some((other) => other !== name && other.toLowerCase().startsWith(prefix));
    if (!shared) keys.add(prefix);
  }
  return [...keys];
}

const NAME_ATTRIBUTES = ['aria-label', 'title', 'alt', 'data-filename', 'data-file-name'];
const PREVIEW_ATTRIBUTES = ['src', 'srcset', 'style'];
const LOCAL_PICTURE = /^(blob:|data:image\/)/i;

/**
 * A local picture the element shows: <img src|srcset>, <source srcset>, or an inline CSS
 * background. Sites preview a picked file from a blob:/data: URL before (or while) uploading it.
 */
function previewUrl(el: Element): string | undefined {
  const tag = el.tagName;
  if (tag === 'IMG' || tag === 'SOURCE') {
    for (const attr of ['src', 'srcset']) {
      const v = (el.getAttribute(attr) || '').trim();
      if (LOCAL_PICTURE.test(v)) return v.split(/\s+/)[0];
    }
    const current = (el as HTMLImageElement).currentSrc;
    if (typeof current === 'string' && LOCAL_PICTURE.test(current)) return current;
  }
  const style = el.getAttribute('style');
  if (style && /url\(/i.test(style)) {
    const m = style.match(/url\(\s*["']?((?:blob:|data:image\/)[^"')\s]+)/i);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

interface AttachmentWatch {
  confirmedCount(): number;
  isConfirmed(name: string): boolean;
  allConfirmed(): boolean;
  lastProgressAt(): number;
  /** Processes pending mutation records right away. */
  flush(): void;
  stop(): void;
}

/**
 * Watches the page (outside the composer and ContextBridge's own notice) for signs that the
 * files are shown: their names in new text or labels, or new blob:/data: preview pictures.
 */
function watchForAttachments(doc: Document, composer: HTMLElement, files: PreparedHandoffFile[]): AttachmentWatch {
  const names = files.map((f) => f.filename);
  const entries = files.map((f) => ({ name: f.filename, image: isImageFile(f), keys: evidenceKeys(f.filename, names) }));
  const allKeys = entries.flatMap((e) => e.keys);
  const confirmed = new Set<string>();
  const seenPreviews = new Set<string>();
  const seenPreviewRoots = new Set<Element>();
  let progressAt = 0;

  // Editable areas hold the pasted text, which names every file: never evidence, even when the
  // site re-creates its editor.
  const excluded = (node: Node): boolean => {
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el) return true;
    if (el === composer || composer.contains(el)) return true;
    try {
      return !!el.closest(`${OWN_UI_SELECTOR}, ${EDITABLE_SELECTOR}, script, style, noscript, template`);
    } catch {
      return false;
    }
  };

  const markText = (text: string): void => {
    if (!text) return;
    const lower = text.toLowerCase();
    for (const e of entries) {
      if (!confirmed.has(e.name) && e.keys.some((k) => lower.includes(k))) {
        confirmed.add(e.name);
        progressAt = Date.now();
      }
    }
  };

  const markPreview = (el: Element): void => {
    const url = previewUrl(el);
    if (!url) return;
    // One picture can be both an <img> and a <source>, or be shown twice: count each URL once.
    const key = `${url.length}:${url.slice(0, 120)}`;
    const root = el.closest?.('picture') || el;
    if (seenPreviews.has(key) || seenPreviewRoots.has(root)) return;
    seenPreviews.add(key);
    seenPreviewRoots.add(root);
    // A labelled preview names its own file (handled as text); an unlabelled one is credited to
    // the next image not yet shown.
    const label = NAME_ATTRIBUTES.map((a) => el.getAttribute(a) || '').join(' ').toLowerCase();
    if (label && allKeys.some((k) => label.includes(k))) return;
    const next = entries.find((e) => e.image && !confirmed.has(e.name));
    if (next) {
      confirmed.add(next.name);
      progressAt = Date.now();
    }
  };

  /** Text, labels and pictures under `node`, skipping the composer (a re-rendered wrapper holds both). */
  const scan = (node: Node, budget: { nodes: number; chars: number }): void => {
    if (budget.nodes-- <= 0 || budget.chars <= 0 || node === composer) return;
    if (node.nodeType === 3) {
      const text = node.nodeValue || '';
      budget.chars -= text.length;
      markText(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    try {
      if (el.matches(EDITABLE_SELECTOR)) return;
    } catch {
      // keep scanning
    }
    for (const attr of NAME_ATTRIBUTES) {
      const v = el.getAttribute(attr);
      if (v) markText(v);
    }
    markPreview(el);
    for (const child of Array.from(el.childNodes)) scan(child, budget);
  };

  const handle = (records: MutationRecord[]): void => {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of Array.from(r.addedNodes)) {
          if (!excluded(n)) scan(n, { nodes: 4000, chars: 50_000 });
        }
      } else if (r.type === 'characterData') {
        if (!excluded(r.target)) markText(r.target.nodeValue || '');
      } else if (r.type === 'attributes' && r.target.nodeType === 1) {
        const el = r.target as Element;
        const attr = r.attributeName;
        if (!attr) continue;
        // style and src change all the time; test the value before the (slower) ancestry check.
        if (PREVIEW_ATTRIBUTES.includes(attr)) {
          if (previewUrl(el) && !excluded(el)) markPreview(el);
        } else if (!excluded(el)) {
          markText(el.getAttribute(attr) || '');
        }
      }
    }
  };

  const ObserverCtor = (doc.defaultView as any)?.MutationObserver || (globalThis as any).MutationObserver;
  let observer: MutationObserver | null = null;
  if (typeof ObserverCtor === 'function') {
    observer = new ObserverCtor(handle) as MutationObserver;
    observer.observe(doc.body || doc.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...PREVIEW_ATTRIBUTES, ...NAME_ATTRIBUTES],
    });
  }

  return {
    confirmedCount: () => confirmed.size,
    isConfirmed: (name) => confirmed.has(name),
    allConfirmed: () => confirmed.size >= entries.length,
    lastProgressAt: () => progressAt,
    flush: () => {
      if (observer && typeof observer.takeRecords === 'function') handle(observer.takeRecords());
    },
    stop: () => {
      if (observer && typeof observer.takeRecords === 'function') handle(observer.takeRecords());
      observer?.disconnect();
      observer = null;
    },
  };
}

interface EvidenceWait {
  /** Wait for the first file to show. */
  firstMs: number;
  /** ...or this long when the page reacted to the hand-over. */
  patienceMs: number;
  reacted: () => boolean;
  /** After the first file: stop when nothing new showed for this long... */
  settleMs: number;
  /** ...or after this long in any case. */
  restMs: number;
}

/** Waits for the first file to show, then for the rest until nothing new shows for a while. */
async function waitForEvidence(watch: AttachmentWatch, wait: EvidenceWait): Promise<void> {
  const start = Date.now();
  const initial = watch.confirmedCount();
  for (;;) {
    watch.flush();
    if (watch.confirmedCount() > initial) break;
    const elapsed = Date.now() - start;
    if (elapsed >= wait.firstMs && !(elapsed < wait.patienceMs && wait.reacted())) return;
    await sleep(100);
  }
  const stopAt = Date.now() + wait.restMs;
  while (!watch.allConfirmed() && Date.now() < stopAt) {
    watch.flush();
    if (Date.now() - watch.lastProgressAt() >= wait.settleMs) break;
    await sleep(100);
  }
}

/**
 * Offers the files through the upload input, then a paste, then a drop, stopping at the first
 * way after which the page shows any of them (so files are not added twice).
 */
export async function attachFiles(
  doc: Document,
  composer: HTMLElement,
  target: Pick<ComposerTargetConfig, 'fileInputSelectors' | 'attachConfirmMs' | 'attachPatienceMs'>,
  files: PreparedHandoffFile[]
): Promise<AttachOutcome> {
  const names = files.map((f) => f.filename);
  if (files.length === 0) return { method: 'none', tried: [], confirmed: [], notConfirmed: [], unverified: [] };
  const domFiles = makeDomFiles(doc, files);
  if (!domFiles) return { method: 'unsupported', tried: [], confirmed: [], notConfirmed: names, unverified: [] };

  const confirmMs = Math.max(0, target.attachConfirmMs ?? 3000);
  const patienceMs = Math.max(confirmMs, target.attachPatienceMs ?? 10_000);
  const settleMs = Math.min(1500, confirmMs);
  const attempts: Array<{ method: AttachMethod; run: () => AttemptRun | Promise<AttemptRun> }> = [];
  const input = pickFileInput(doc, target.fileInputSelectors, files);
  if (input) attempts.push({ method: 'file-input', run: () => tryFileInput(input, doc, domFiles) });
  attempts.push({ method: 'paste', run: () => tryPaste(composer, doc, domFiles) });
  attempts.push({ method: 'drop', run: () => tryDrop(composer, doc, domFiles) });

  const watch = watchForAttachments(doc, composer, files);
  const tried: AttachMethod[] = [];
  let method: AttachOutcome['method'] = 'none';
  let anyReacted = false;
  try {
    for (const attempt of attempts) {
      const picturesBefore = inlinePictures(composer);
      let run: AttemptRun;
      try {
        run = await attempt.run();
      } catch {
        run = { ok: false };
      }
      if (!run.ok) continue;
      tried.push(attempt.method);
      // An editor that inlined the pictures itself (e.g. Quill's uploader) is not the page
      // taking the files.
      const reacted = () => !!run.reacted?.() && !hasNewInlinePictures(composer, picturesBefore);
      await waitForEvidence(watch, { firstMs: confirmMs, patienceMs, reacted, settleMs, restMs: confirmMs * 3 });
      if (reacted()) anyReacted = true;
      removeNewInlinePictures(composer, picturesBefore);
      if (watch.confirmedCount() > 0) {
        method = attempt.method;
        break;
      }
      run.undo?.();
    }
  } finally {
    watch.stop();
  }
  if (method === 'none' && tried.length === 0) method = 'unsupported';
  const confirmed = names.filter((n) => watch.isConfirmed(n));
  const missing = names.filter((n) => !watch.isConfirmed(n));
  // Nothing showed, but the page took at least one hand-over: the files may be there, shown in
  // a way ContextBridge does not recognise. That is "check", not "attach again".
  const unverified = confirmed.length === 0 && anyReacted ? missing : [];
  return {
    method,
    tried,
    confirmed,
    notConfirmed: unverified.length > 0 ? [] : missing,
    unverified,
  };
}

function nonEmpty(list: string[]): string[] | undefined {
  return list.length > 0 ? list : undefined;
}

export async function injectHandoffIntoComposer(
  handoff: PreparedHandoff,
  doc: Document,
  target: ComposerTargetConfig
): Promise<ImportResult> {
  const safeFiles = (handoff.files || []).filter(
    (f) => !f.filename.toLowerCase().endsWith('.ctxbridge') && f.mimeType !== 'application/x-contextbridge'
  );

  // Sites refuse a whole batch over their per-message limit; send what fits, list the rest.
  const limit = target.maxFiles ?? platformInfo(target.platform)?.maxFilesPerMessage;
  const sendNow = limit === undefined ? safeFiles : safeFiles.slice(0, Math.max(0, limit));
  const overLimit = [
    ...safeFiles.slice(sendNow.length).map((f) => f.filename),
    ...(handoff.metadata?.filesOverLimit ?? []),
  ];
  const fileLimit = overLimit.length > 0 ? (limit ?? handoff.metadata?.fileLimit) : undefined;

  const composer = await waitForComposer(doc, target.composerSelectors, target.composerTimeoutMs ?? 10_000);
  if (!composer) {
    return {
      success: false,
      targetPlatform: target.platform,
      strategyUsed: handoff.strategy,
      injectedPromptLength: 0,
      attachedFilesCount: 0,
      manualAttachmentRequiredFiles: nonEmpty([...sendNow.map((f) => f.filename), ...overLimit]),
      filesOverLimit: nonEmpty(overLimit),
      fileLimit,
      failureReason: 'composer_not_found',
      attachMethod: 'none',
      message: `Could not find the ${target.displayName} message box on this page. Sign in or open a new chat, then try again.`,
    };
  }

  const text = await insertTextIntoComposer(composer, handoff.promptText, doc);

  let outcome: AttachOutcome = { method: 'none', tried: [], confirmed: [], notConfirmed: [], unverified: [] };
  if (sendNow.length > 0) outcome = await attachFiles(doc, composer, target, sendNow);

  const notes: string[] = [];
  const how = outcome.tried.length > 0 ? `tried ${outcome.tried.join(', ')}` : 'no way to hand files over';
  if (outcome.confirmed.length > 0) {
    notes.push(`${outcome.confirmed.length} file(s) shown by ${target.displayName} (${outcome.method}).`);
  }
  if (outcome.notConfirmed.length > 0) notes.push(`Not confirmed (${how}): ${outcome.notConfirmed.join(', ')}.`);
  if (outcome.unverified.length > 0) {
    notes.push(`Page reacted but showed none (${how}): ${outcome.unverified.join(', ')}.`);
  }
  if (overLimit.length > 0) notes.push(`Over the ${fileLimit}-file limit: ${overLimit.join(', ')}.`);
  const filesNote = notes.length > 0 ? ` ${notes.join(' ')}` : '';

  return {
    success: text.ok,
    targetPlatform: target.platform,
    strategyUsed: handoff.strategy,
    injectedPromptLength: text.ok ? handoff.promptText.length : 0,
    attachedFilesCount: outcome.confirmed.length,
    attachedFiles: nonEmpty(outcome.confirmed),
    filesNotConfirmed: nonEmpty(outcome.notConfirmed),
    filesUnverified: nonEmpty(outcome.unverified),
    filesOverLimit: nonEmpty(overLimit),
    fileLimit,
    manualAttachmentRequiredFiles: nonEmpty([...outcome.notConfirmed, ...outcome.unverified, ...overLimit]),
    failureReason: text.ok ? undefined : 'text_not_verified',
    attachMethod: outcome.method,
    message: text.ok
      ? `Added to the ${target.displayName} message box (${text.method}). Review it, then send.${filesNote}`
      : `Could not confirm the text in the ${target.displayName} message box (${text.method}).${filesNote}`,
  };
}
