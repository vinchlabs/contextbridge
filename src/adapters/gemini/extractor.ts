/**
 * DOM extractor for Google Gemini turns (<user-query> and <model-response>).
 *
 * Content is read in document order by the shared walker. Gemini specifics:
 * - the prompt text lives in `.query-text`; everything else in <user-query> is either an
 *   attachment (pictures, videos, file chips) or page chrome ("You said" labels, edit buttons);
 * - uploaded files are chips ("CSV" + a name) without a download link in the page, so they
 *   become named file references that the capture reports as not readable;
 * - replies skip Gemini's chrome (avatar, "Show thinking", sources, action bars).
 */

import { MessageRole, ContentPart } from '../../core/model/canonical';
import { hasKnownFileExtension, mimeForFilename, fileExtension } from '../../core/model/attachments';
import { contentFingerprint } from '../../utils/dom';
import { isIconLikeImage, walkMessageContent } from '../content-walker';
import { ExtractedMediaReference, ExtractedMessageResult, extractImageUrl } from '../chatgpt/extractor';

/** Gemini page chrome inside turns. */
const GEMINI_CHROME = [
  'bard-avatar',
  'model-thoughts',
  '.model-thoughts',
  'message-actions',
  '.message-actions',
  'sources-list',
  'sources-carousel',
  'source-footnote',
  'source-inline-chip',
  'response-container-header',
  '.response-container-header',
  'tts-control',
  'mat-menu',
  '.response-footer',
  '.table-footer',
  '.response-container-footer',
  '[role="toolbar"]',
  '[role="menu"]',
  '[role="tooltip"]',
].join(', ');

function isGeminiChrome(el: Element): boolean {
  try {
    return el.matches(GEMINI_CHROME);
  } catch {
    return false;
  }
}

/** Where a file chip keeps its full name. */
const NAME_ATTRIBUTES = ['data-file-name', 'data-filename', 'title', 'aria-label', 'data-tooltip', 'mattooltip'];

/** The type label a chip shows next to a name that has no extension ("CSV", "PDF"). */
const TYPE_LABEL = /^[A-Z0-9]{2,5}$/;

export interface GeminiFileChip {
  el: Element;
  filename: string;
  url?: string;
}

/** The clickable chip around a labelled element, but never a container of the prompt. */
function chipRoot(el: Element, turnEl: Element, textRoot: Element | null): Element {
  const control = el.closest('button, [role="button"], a');
  if (control && control !== turnEl && turnEl.contains(control) && !(textRoot && control.contains(textRoot))) {
    return control;
  }
  return el;
}

/** Visible text of `root` without `exclude`, pieces joined by spaces (chips stack them in divs). */
function textExcept(root: Element, exclude: Element): string {
  const pieces: string[] = [];
  const walk = (node: Node) => {
    if (node === exclude) return;
    if (node.nodeType === 3) {
      const t = (node.nodeValue || '').trim();
      if (t) pieces.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (/^(BUTTON|SVG|MAT-ICON|SCRIPT|STYLE)$/.test(el.tagName) || el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return;
    if (/visually-hidden|sr-only|material-icons|material-symbols|google-symbols/.test(typeof el.className === 'string' ? el.className : '')) return;
    for (const child of Array.from(el.childNodes)) walk(child);
  };
  walk(root);
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

/** "Remove file report.pdf" -> "report.pdf". */
function nameFromLabel(value: string): string {
  return value
    .replace(/^(?:(?:remove|delete|open|preview|download|view|file|attachment|удалить|открыть|скачать|просмотреть|просмотр|файл|вложение)\b[:\s-]*)+/i, '')
    .trim();
}

function hasRealPicture(el: Element): boolean {
  return Array.from(el.querySelectorAll('img')).some((img) => {
    const url = extractImageUrl(img);
    return !!url && !isIconLikeImage(img, url);
  });
}

/**
 * Uploaded-file chips of a prompt: a known file name in a label attribute, or a short type label
 * ("CSV") next to a name without extension. Pictures are not chips (the walker takes them).
 */
export function findGeminiFileChips(turnEl: Element, textRoot: Element | null): GeminiFileChip[] {
  const chips: GeminiFileChip[] = [];
  const names = new Set<string>();
  const inChip = (el: Element) => chips.some((c) => c.el === el || c.el.contains(el) || el.contains(c.el));
  const add = (root: Element, filename: string) => {
    if (inChip(root) || hasRealPicture(root)) return;
    const key = filename.toLowerCase();
    if (names.has(key)) return;
    names.add(key);
    const link = root.closest('a[href]') || root.querySelector('a[href]');
    const href = link?.getAttribute('href') || '';
    chips.push({ el: root, filename, url: /^https?:/i.test(href) ? href : undefined });
  };

  const all = Array.from(turnEl.querySelectorAll('*'));
  for (const el of all) {
    if (textRoot && (textRoot === el || textRoot.contains(el))) continue;
    if (/^(IMG|VIDEO|AUDIO|SOURCE|SVG)$/.test(el.tagName) || isGeminiChrome(el)) continue;
    for (const attr of NAME_ATTRIBUTES) {
      const raw = el.getAttribute(attr)?.trim();
      const v = raw ? nameFromLabel(raw) : '';
      if (v && v.length <= 200 && !v.includes('\n') && hasKnownFileExtension(v)) {
        add(chipRoot(el, turnEl, textRoot), v);
        break;
      }
    }
  }

  // Type label + name only in Gemini's current layout (the prompt in .query-text), so a prompt
  // that is just "PDF" is never mistaken for a chip.
  if (!textRoot) return chips;
  for (const el of all) {
    if (el.children.length > 0 || textRoot.contains(el)) continue;
    const label = (el.textContent || '').trim();
    if (!TYPE_LABEL.test(label) || !hasKnownFileExtension(`x.${label.toLowerCase()}`)) continue;
    if (inChip(el)) continue;
    // The smallest ancestor that also shows a name: one chip, not the row of chips.
    let holder: Element | null = el.parentElement;
    while (holder && holder !== turnEl && !textExcept(holder, el)) holder = holder.parentElement;
    if (!holder || holder === turnEl || holder.contains(textRoot)) continue;
    const name = textExcept(holder, el);
    if (!name || name.length > 160) continue;
    const ext = label.toLowerCase();
    add(holder, fileExtension(name) === ext ? name : `${name}.${ext}`);
  }
  return chips;
}

export function extractGeminiMessage(turnEl: Element, sequenceIndex: number): ExtractedMessageResult | null {
  const tag = turnEl.tagName.toLowerCase();
  const className = typeof turnEl.className === 'string' ? turnEl.className : '';
  const role: MessageRole = tag === 'user-query' || className.includes('user-query') ? 'user' : 'assistant';

  // The positional fallback (`gemini-turn-${index}`) collided as soon as older turns were
  // prepended; prefer real ids, then the turn container id, then a content fingerprint.
  const ownId = turnEl.getAttribute('id');
  const containerId = turnEl.closest('.conversation-container')?.getAttribute('id');
  const stableId = ownId
    ? `gemini-${ownId}`
    : containerId
      ? `gemini-${containerId}:${role}`
      : `gemini-${role}-${contentFingerprint(turnEl.textContent || '')}`;

  const mediaRefs: ExtractedMediaReference[] = [];
  let content: ContentPart[];

  if (role === 'user') {
    const textRoot = turnEl.querySelector('.query-text, [class*="query-text"]');
    const chips = findGeminiFileChips(turnEl, textRoot);
    const isChip = (el: Element) => chips.some((c) => c.el === el);
    const chipParts: ContentPart[] = chips.map((chip) => {
      const url = chip.url || `gemini-file://${encodeURIComponent(chip.filename)}`;
      const mimeType = mimeForFilename(chip.filename) || 'application/octet-stream';
      mediaRefs.push({ url, role: 'user-upload', filename: chip.filename, mimeType });
      return { type: 'file', blobSha256: url, filename: chip.filename, mimeType };
    });

    if (textRoot) {
      // Attachments come from the rest of the turn (their captions are chrome); the prompt
      // text only from .query-text, so hidden copies of it are never read twice.
      const media = walkMessageContent(turnEl, mediaRefs, {
        role: 'user-upload',
        skip: (el) => el === textRoot || isChip(el) || isGeminiChrome(el),
      }).filter((p) => p.type !== 'text');
      const text = walkMessageContent(textRoot, mediaRefs, { role: 'user-upload', skip: isGeminiChrome });
      content = [...chipParts, ...media, ...text];
    } else {
      const parts = walkMessageContent(turnEl, mediaRefs, {
        role: 'user-upload',
        skip: (el) => isChip(el) || isGeminiChrome(el),
      });
      content = [...chipParts, ...parts];
    }
  } else {
    content = walkMessageContent(turnEl, mediaRefs, { role: 'assistant-generated', skip: isGeminiChrome });
  }

  if (content.length === 0) return null;

  return {
    message: {
      id: stableId,
      role,
      sequence: sequenceIndex,
      content,
    },
    mediaRefs,
  };
}
