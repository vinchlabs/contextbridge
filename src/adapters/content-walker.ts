/**
 * Document-order conversion of a chat message's DOM into canonical content parts. Used for
 * Gemini (no message API) and as Claude's DOM fallback.
 *
 * Text is taken as rendered: headings, paragraphs, lists and quotes become Markdown lines, code
 * blocks keep their language, tables stay tables, and pictures, videos and audio become media
 * references where they appear. Page chrome is skipped: buttons, icons, screen-reader labels,
 * hidden elements and editors. A block repeated right after itself is dropped.
 */

import type { BlobRole, ContentPart } from '../core/model/canonical';
import { mimeForFilename } from '../core/model/attachments';
import { extractTableData } from '../utils/dom';
import { extractImageUrl, type ExtractedMediaReference } from './chatgpt/extractor';

export interface WalkOptions {
  /** Owner of the pictures and files found in this message. */
  role: BlobRole;
  /** Site-specific page chrome to skip entirely (text and media). */
  skip?: (el: Element) => boolean;
  /** Site-specific code block containers besides <pre> and <code-block>. */
  isCodeBlock?: (el: Element) => boolean;
}

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
  'IFRAME', 'CANVAS', 'LINK', 'META', 'MAT-ICON', 'OBJECT', 'EMBED', 'PROGRESS', 'METER',
]);
/** Screen-reader-only text ("You said", "Ваш запрос") and icon ligatures ("content_copy"). */
const HIDDEN_CLASS = /(?:^|\s)(?:cdk-visually-hidden|sr-only|visually-hidden|screen-reader-only|a11y-hidden)(?:\s|$)/;
const ICON_CLASS = /(?:^|\s)(?:material-icons[\w-]*|material-symbols[\w-]*|google-symbols|gds-icon[\w-]*|mat-icon)(?:\s|$)/;
const CODE_WRAPPER_CLASS = /(?:^|[\s_-])(?:code-block|codeblock|code-container|highlight|syntax)(?:[\s_-]|$)/i;
const BLOCK_DESCENDANTS = 'p, div, pre, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, img, video, audio, code-block';
const UI_WORDS = /^(copy|copied|run|edit|show|hide|preview|expand|collapse|download|share|копировать|скопировать|скопировано|показать|скрыть|развернуть|свернуть|скачать)$/i;

function classOf(el: Element): string {
  const c = (el as HTMLElement).className;
  return typeof c === 'string' ? c : el.getAttribute('class') || '';
}

/** Not rendered at all: skip text and media. */
function isHidden(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute('hidden')) return true;
  const cls = classOf(el);
  if (HIDDEN_CLASS.test(cls) || ICON_CLASS.test(cls)) return true;
  const style = el.getAttribute('style') || '';
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return true;
  const ce = el.getAttribute('contenteditable');
  return ce === '' || ce === 'true' || ce === 'plaintext-only';
}

/** Controls and decorative wrappers: their labels are not content, but a thumbnail inside is. */
function isMediaOnly(el: Element): boolean {
  return el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('aria-hidden') === 'true';
}

/** UI pictures (avatars, favicons of cited sites, icons). Alt text is not used: it may be a prompt. */
export function isIconLikeImage(el: Element, url: string): boolean {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.startsWith('data:image/svg') || /favicon|avatar|\/icons?\//.test(lowerUrl)) return true;
  if (/(?:^|[\s_-])(?:avatar|favicon|logo|icon|emoji)(?:$|[\s_-])/i.test(classOf(el))) return true;
  const w = Number(el.getAttribute('width'));
  const h = Number(el.getAttribute('height'));
  return (w > 0 && w < 28) || (h > 0 && h < 28);
}

/** Text a person sees in `el`: without buttons, icon ligatures and screen-reader labels. */
export function visibleText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone
    .querySelectorAll('button, svg, mat-icon, [aria-hidden="true"], [hidden], [class*="visually-hidden"], [class*="sr-only"], [class*="material-icons"], [class*="material-symbols"], [class*="google-symbols"]')
    .forEach((n) => n.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const decoded = decodeURIComponent(last);
    return /\.[a-z0-9]{2,5}$/i.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function codeLanguage(block: Element, codeEl: Element): string | undefined {
  const pre = block.querySelector('pre');
  const holders = [block, codeEl, ...(pre ? [pre] : [])];
  for (const h of holders) {
    const m = classOf(h).match(/(?:^|\s)(?:language|lang)-([a-z0-9_+#-]+)/i);
    if (m?.[1]) return m[1].toLowerCase();
  }
  for (const h of holders) {
    const attr = h.getAttribute('language') || h.getAttribute('data-language') || h.getAttribute('data-lang');
    if (attr?.trim()) return attr.trim().toLowerCase();
  }
  // A label in the block's header (Gemini: "Python" above the code), never inside the code.
  // Leaf elements only: a header row also holds the copy button.
  const labels = Array.from(block.querySelectorAll('span, div, label'));
  for (const label of labels) {
    if (label.children.length > 0) continue;
    if (label.contains(codeEl) || codeEl.contains(label) || (pre && pre.contains(label)) || label.closest('button')) continue;
    if (isHidden(label)) continue;
    const text = visibleText(label);
    if (text && text.length <= 20 && /^[A-Za-z][A-Za-z0-9+#._ -]*$/.test(text) && !UI_WORDS.test(text)) {
      return text.toLowerCase().replace(/\s+/g, '-');
    }
  }
  return undefined;
}

function codeText(codeEl: Element): string {
  const clone = codeEl.cloneNode(true) as Element;
  clone.querySelectorAll('button, svg, mat-icon, [aria-hidden="true"]').forEach((n) => n.remove());
  return (clone.textContent || '').replace(/\n$/, '');
}

class Walker {
  readonly parts: ContentPart[] = [];
  private buf = '';
  private readonly seenMedia = new Set<string>();

  constructor(
    private readonly mediaRefs: ExtractedMediaReference[],
    private readonly opts: WalkOptions
  ) {}

  private skipped(el: Element): boolean {
    return isHidden(el) || (this.opts.skip?.(el) ?? false);
  }

  private isCodeBlock(el: Element): boolean {
    const tag = el.tagName;
    if (tag === 'PRE' || tag === 'CODE-BLOCK') return true;
    if (this.opts.isCodeBlock?.(el)) return true;
    if (tag === 'CODE') return (el.textContent || '').includes('\n');
    return (
      CODE_WRAPPER_CLASS.test(classOf(el)) &&
      !!el.querySelector('pre, code') &&
      !el.querySelector('p, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote')
    );
  }

  private pushText(text: string): void {
    const last = this.parts[this.parts.length - 1];
    if (last?.type === 'text' && last.text === text) return;
    this.parts.push({ type: 'text', text });
  }

  flush(): void {
    const text = this.buf
      .replace(/[ \t\u00a0]+\n/g, '\n')
      .replace(/\n[ \t\u00a0]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    this.buf = '';
    if (text) this.pushText(text);
  }

  private pushImage(el: Element): void {
    const url = extractImageUrl(el);
    if (!url || isIconLikeImage(el, url) || this.seenMedia.has(url)) return;
    this.seenMedia.add(url);
    const alt = el.getAttribute('alt')?.trim() || undefined;
    this.mediaRefs.push({ url, role: this.opts.role, altText: alt });
    this.parts.push({ type: 'image', blobSha256: url, altText: alt });
  }

  private pushAudioVideo(el: Element): void {
    const media = el as HTMLMediaElement;
    const source = el.querySelector('source[src]');
    const url = media.currentSrc || el.getAttribute('src') || source?.getAttribute('src') || '';
    if (!url || this.seenMedia.has(url)) return;
    this.seenMedia.add(url);
    const isVideo = el.tagName === 'VIDEO';
    const named = fileNameFromUrl(url) || el.getAttribute('title') || el.getAttribute('aria-label') || undefined;
    const fallbackName = isVideo ? 'video.mp4' : 'audio.mp3';
    const filename = named && /\.[a-z0-9]{2,5}$/i.test(named) ? named : fallbackName;
    const declared = source?.getAttribute('type')?.split(';')[0]?.trim();
    const mimeType = declared || mimeForFilename(filename) || (isVideo ? 'video/mp4' : 'audio/mpeg');
    this.mediaRefs.push({ url, role: this.opts.role, filename, mimeType });
    this.parts.push({ type: 'file', blobSha256: url, filename, mimeType });
  }

  /** Pictures and players inside a control or decorative wrapper. */
  private collectMedia(el: Element): void {
    for (const m of Array.from(el.querySelectorAll('img, video, audio'))) {
      if (this.skipped(m)) continue;
      if (m.tagName === 'IMG') {
        if (!m.closest('video, audio')) this.pushImage(m);
      } else {
        this.pushAudioVideo(m);
      }
    }
  }

  private pushCode(el: Element): void {
    const codeEl = el.tagName === 'CODE' ? el : el.querySelector('pre code') || el.querySelector('code') || el.querySelector('pre') || el;
    const code = codeText(codeEl);
    if (!code.trim()) return;
    this.parts.push({ type: 'code', code, language: codeLanguage(el, codeEl) });
  }

  /** Inline Markdown of an element whose content is inline only. */
  private inline(node: Node): string {
    if (node.nodeType === 3) return (node.nodeValue || '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    if (this.skipped(el) || isMediaOnly(el)) return '';
    const inner = () => Array.from(el.childNodes).map((c) => this.inline(c)).join('');
    switch (el.tagName) {
      case 'BR':
        return '\n';
      case 'STRONG':
      case 'B': {
        const t = inner().trim();
        return t ? `**${t}**` : '';
      }
      case 'EM':
      case 'I': {
        const t = inner().trim();
        return t ? `*${t}*` : '';
      }
      case 'DEL':
      case 'S': {
        const t = inner().trim();
        return t ? `~~${t}~~` : '';
      }
      case 'CODE': {
        const t = (el.textContent || '').trim();
        return t ? `\`${t}\`` : '';
      }
      case 'A': {
        const t = inner().trim();
        const href = el.getAttribute('href') || '';
        if (!t) return '';
        if (!href || href.startsWith('#') || /^javascript:/i.test(href) || href === t) return t;
        return `[${t}](${href})`;
      }
      default:
        return inner();
    }
  }

  private flushLines(lines: string[]): void {
    if (lines.length > 0) this.pushText(lines.join('\n'));
    lines.length = 0;
  }

  /** Markdown list lines (nested lists indented); code, tables and media inside items in place. */
  private walkList(list: Element, depth: number, lines: string[]): void {
    const ordered = list.tagName === 'OL';
    const start = Number(list.getAttribute('start')) || 1;
    const items = Array.from(list.children).filter((c) => c.tagName === 'LI' && !this.skipped(c));
    items.forEach((li, i) => {
      const marker = ordered ? `${start + i}.` : '-';
      let line = '';
      const nested: Element[] = [];
      const blocks: Element[] = [];
      const collect = (parent: Element) => {
        for (const child of Array.from(parent.childNodes)) {
          if (child.nodeType === 1) {
            const c = child as Element;
            if (this.skipped(c)) continue;
            if (c.tagName === 'UL' || c.tagName === 'OL') {
              nested.push(c);
              continue;
            }
            if (this.isCodeBlock(c) || ['TABLE', 'IMG', 'VIDEO', 'AUDIO'].includes(c.tagName) || isMediaOnly(c)) {
              blocks.push(c);
              continue;
            }
            // <li><p>text</p><ul>..</ul></li>: paragraphs inside items are part of the line.
            if (c.tagName === 'P' || c.tagName === 'DIV') {
              line += ' ';
              collect(c);
              continue;
            }
          }
          line += this.inline(child);
        }
      };
      collect(li);
      const text = line.replace(/\s+/g, ' ').trim();
      if (text) lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
      if (blocks.length > 0) {
        this.flushLines(lines);
        for (const b of blocks) this.visit(b);
      }
      for (const n of nested) this.walkList(n, depth + 1, lines);
    });
  }

  visit(node: Node): void {
    if (node.nodeType === 3) {
      this.buf += (node.nodeValue || '').replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (this.skipped(el)) return;
    if (isMediaOnly(el)) {
      this.flush();
      this.collectMedia(el);
      return;
    }
    const tag = el.tagName;

    if (tag === 'IMG') {
      this.flush();
      this.pushImage(el);
      return;
    }
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      this.flush();
      this.pushAudioVideo(el);
      return;
    }
    if (this.isCodeBlock(el)) {
      this.flush();
      this.pushCode(el);
      return;
    }
    if (tag === 'TABLE') {
      this.flush();
      const { headers, rows } = extractTableData(el);
      if (headers.length > 0 || rows.length > 0) this.parts.push({ type: 'table', headers, rows });
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      this.flush();
      const text = this.inline(el).replace(/\s+/g, ' ').trim();
      if (text) this.pushText(`${'#'.repeat(Number(tag[1]))} ${text}`);
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      this.flush();
      const lines: string[] = [];
      this.walkList(el, 0, lines);
      this.flushLines(lines);
      return;
    }
    if (tag === 'BLOCKQUOTE') {
      this.flush();
      const inner = new Walker(this.mediaRefs, this.opts);
      for (const child of Array.from(el.childNodes)) inner.visit(child);
      inner.flush();
      for (const part of inner.parts) {
        if (part.type === 'text') this.pushText(part.text.split('\n').map((l) => `> ${l}`).join('\n'));
        else this.parts.push(part);
      }
      return;
    }
    if (tag === 'HR') {
      this.flush();
      this.pushText('---');
      return;
    }
    if (tag === 'BR') {
      this.buf += '\n';
      return;
    }
    // Inline formatting without blocks inside stays in the current paragraph.
    if (['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'DEL', 'S'].includes(tag) && !el.querySelector(BLOCK_DESCENDANTS)) {
      this.buf += this.inline(el);
      return;
    }
    const isInline = ['SPAN', 'A', 'STRONG', 'B', 'EM', 'I', 'SUB', 'SUP', 'MARK', 'SMALL', 'U', 'S', 'DEL', 'INS', 'KBD', 'ABBR', 'TIME', 'Q', 'CITE', 'LABEL', 'FONT'].includes(tag);
    if (!isInline) this.flush();
    for (const child of Array.from(el.childNodes)) this.visit(child);
    if (!isInline) this.flush();
  }
}

/** Content parts of `root` in document order; media found is appended to `mediaRefs`. */
export function walkMessageContent(
  root: Element,
  mediaRefs: ExtractedMediaReference[],
  opts: WalkOptions
): ContentPart[] {
  const walker = new Walker(mediaRefs, opts);
  for (const child of Array.from(root.childNodes)) walker.visit(child);
  walker.flush();

  // Paragraphs next to each other read as one Markdown text part.
  const merged: ContentPart[] = [];
  for (const part of walker.parts) {
    const last = merged[merged.length - 1];
    if (part.type === 'text' && last?.type === 'text') {
      if (last.text !== part.text) last.text += `\n\n${part.text}`;
    } else {
      merged.push(part);
    }
  }
  return merged;
}
