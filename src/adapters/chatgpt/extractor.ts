/**
 * DOM extractor for ChatGPT messages
 * Supports modern virtualized DOM with [data-turn-key] and [data-content-search-unit-key],
 * as well as legacy DOM fallback.
 * Preserves strict document order across text, code blocks, tables, and media.
 */

import {
  Message,
  MessageRole,
  ContentPart,
  BlobRole,
} from '../../core/model/canonical';
import { extractTableData } from '../../utils/dom';
import { CHATGPT_SELECTORS } from './selectors';
import { FileCardCandidateDiagnostic } from '../../core/diagnostics/diagnostics';
import { findUserFileCards, DetectedUserFileCard } from './file-card-detector';

export interface ExtractedMediaReference {
  url: string;
  role: BlobRole;
  filename?: string;
  altText?: string;
  mimeType?: string;
  fallbackData?: Uint8Array;
}

export interface ExtractedMessageResult {
  message: Message;
  mediaRefs: ExtractedMediaReference[];
  intraTurnIndex?: number;
  isAttachmentSentinel?: boolean;
  isUnresolvedAttachment?: boolean;
  structuralCandidates?: FileCardCandidateDiagnostic[];
  detectedFileCards?: DetectedUserFileCard[];
}

export interface ParsedRoleResult {
  role: MessageRole;
  originalRoleToken?: string;
}

/**
 * Robust role parser extracting role from semantic unit key.
 * Format: "fallback-turn-4:0:user" -> "user", "fallback-turn-4:2:assistant" -> "assistant"
 * Does not assume hardcoded numeric indices.
 */
export function parseRoleFromUnitKey(unitKey: string): ParsedRoleResult {
  const trimmed = unitKey.trim();
  const colonIndex = trimmed.lastIndexOf(':');
  const roleToken = (colonIndex >= 0 ? trimmed.slice(colonIndex + 1) : trimmed).toLowerCase();

  if (roleToken === 'user') {
    return { role: 'user' };
  }
  if (roleToken === 'assistant') {
    return { role: 'assistant' };
  }
  if (roleToken === 'system') {
    return { role: 'system' };
  }
  if (roleToken === 'tool') {
    return { role: 'tool' };
  }

  // Preserve unknown future roles without crashing capture
  return {
    role: 'assistant',
    originalRoleToken: roleToken,
  };
}

/**
 * Extracts real provider message ID.
 * Prefers [data-chatgpt-selection-message-id], falls back to [data-chatgpt-search-message-ids].
 */
export function extractMessageId(unitEl: Element, fallbackId: string): string {
  // 1. Prefer [data-chatgpt-selection-message-id]
  const selEl =
    unitEl.querySelector(CHATGPT_SELECTORS.IDENTIFIERS.SELECTION_MESSAGE_ID) ||
    (unitEl.matches(CHATGPT_SELECTORS.IDENTIFIERS.SELECTION_MESSAGE_ID) ? unitEl : null);
  const selectionId = selEl?.getAttribute('data-chatgpt-selection-message-id');
  if (selectionId && selectionId.trim()) {
    return selectionId.trim();
  }

  // 2. Fallback to [data-chatgpt-search-message-ids]
  const searchEl =
    unitEl.querySelector(CHATGPT_SELECTORS.IDENTIFIERS.SEARCH_MESSAGE_IDS) ||
    (unitEl.matches(CHATGPT_SELECTORS.IDENTIFIERS.SEARCH_MESSAGE_IDS) ? unitEl : null);
  const searchIds = searchEl?.getAttribute('data-chatgpt-search-message-ids');
  if (searchIds && searchIds.trim()) {
    const firstId = searchIds.trim().split(/\s+/)[0];
    if (firstId) {
      return firstId;
    }
  }

  // 3. Fallback to generic [data-message-id]
  const genEl =
    unitEl.querySelector(CHATGPT_SELECTORS.IDENTIFIERS.GENERIC_MESSAGE_ID) ||
    (unitEl.matches(CHATGPT_SELECTORS.IDENTIFIERS.GENERIC_MESSAGE_ID) ? unitEl : null);
  const genId = genEl?.getAttribute('data-message-id');
  if (genId && genId.trim()) {
    return genId.trim();
  }

  return fallbackId;
}

/**
 * Extracts conversation ID from the DOM if available.
 */
export function extractConversationId(root: Element | Document): string | undefined {
  const el = root.querySelector(CHATGPT_SELECTORS.IDENTIFIERS.SELECTION_CONVERSATION_ID);
  const convId = el?.getAttribute('data-chatgpt-selection-conversation-id');
  return convId?.trim() || undefined;
}

/**
 * Converts inline elements (links, bold, italic, code) into Markdown text.
 */
export function inlineElementToMarkdown(element: Element): string {
  const clone = element.cloneNode(true) as Element;

  // Remove UI buttons, SVGs, copy indicators
  clone
    .querySelectorAll('button, svg, [class*="copy" i], [aria-label*="copy" i]')
    .forEach((btn) => btn.remove());

  // Inline code (skip preformatted code inside PRE or code blocks)
  clone.querySelectorAll('code').forEach((c) => {
    if (!c.closest('pre')) {
      c.textContent = `\`${c.textContent}\``;
    }
  });

  // Bold
  clone.querySelectorAll('strong, b').forEach((b) => {
    b.textContent = `**${b.textContent}**`;
  });

  // Italic
  clone.querySelectorAll('em, i').forEach((i) => {
    i.textContent = `*${i.textContent}*`;
  });

  // Links and citations
  clone.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    const text = a.textContent?.trim() || href;
    if (href && !href.startsWith('javascript:')) {
      a.textContent = `[${text}](${href})`;
    }
  });

  return clone.textContent?.trim() || '';
}

/**
 * Checks if an element is a self-contained code block or code block wrapper.
 */
export function isCodeBlockContainer(el: Element): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === 'PRE') return true;

  if (tag === 'CODE') {
    const className = el.className || '';
    const hasSyntaxClass = /hljs|language-|whitespace-pre/.test(className);
    const hasNewlines = (el.textContent || '').includes('\n');
    return hasSyntaxClass || hasNewlines;
  }

  // Must not enclose other major document blocks (paragraphs, tables, lists, etc.)
  const hasOtherBlocks = Boolean(
    el.querySelector('p, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, hr')
  );
  if (hasOtherBlocks) return false;

  const hasPre = Boolean(el.querySelector('pre'));
  const codeEl = el.querySelector('code');
  if (!hasPre && !codeEl) return false;

  if (hasPre) return true;

  if (codeEl) {
    const codeClass = codeEl.className || '';
    const elClass = el.className || '';
    const hasSyntaxClass = /hljs|language-|whitespace-pre/.test(`${codeClass} ${elClass}`);
    const hasCopyButton = Boolean(
      el.querySelector('button[aria-label*="copy" i], button[data-testid*="copy" i]') ||
      Array.from(el.querySelectorAll('button')).some((b) => /copy/i.test(b.textContent || ''))
    );
    const hasCodeClass = /code-block|codeblock|code_|syntax/i.test(elClass);
    const hasNewlines = (codeEl.textContent || '').includes('\n');

    return hasSyntaxClass || hasCopyButton || hasCodeClass || hasNewlines;
  }

  return false;
}

/**
 * Extracts clean code and detected language from a code block or container.
 */
export function extractCodeBlock(el: Element): { code: string; language?: string } {
  const codeEl = el.querySelector('code') || el.querySelector('pre') || el;
  const clone = codeEl.cloneNode(true) as Element;

  // Strip UI buttons, SVGs, and copy labels
  clone
    .querySelectorAll('button, svg, [class*="copy" i], [aria-label*="copy" i]')
    .forEach((b) => b.remove());

  const rawCode = clone.textContent || '';
  const code = rawCode.replace(/\n$/, '');

  let lang: string | undefined;

  // 1. Language from class names
  const allClassNames = `${el.className || ''} ${codeEl.className || ''}`;
  const langMatch = allClassNames.match(/(?:language|lang)-([a-zA-Z0-9_#-]+)/i);
  if (langMatch && langMatch[1]) {
    lang = langMatch[1].toLowerCase();
  }

  // 2. Language from attributes
  if (!lang) {
    const dataLang =
      el.getAttribute('data-language') ||
      codeEl.getAttribute('data-language') ||
      el.getAttribute('data-lang') ||
      codeEl.getAttribute('data-lang');
    if (dataLang) {
      lang = dataLang.trim().toLowerCase();
    }
  }

  // 3. Language from header element
  if (!lang) {
    const headers = Array.from(
      el.querySelectorAll('[class*="text-xs"], [class*="header"], span, div')
    );
    for (const h of headers) {
      if (h.closest('button')) continue;
      const text = h.textContent?.trim().toLowerCase();
      if (
        text &&
        text.length <= 25 &&
        /^[a-z0-9_#-]+$/.test(text) &&
        !['copy', 'copied', 'code', 'run', 'edit', 'preview'].includes(text)
      ) {
        lang = text;
        break;
      }
    }
  }

  return { code, language: lang };
}

/**
 * Semantic block walker over an assistant message root.
 * Walks the DOM in strict document order, preserving ordered content:
 * text/paragraph -> code block -> text -> code block -> table etc.
 * Avoids duplicate text from pre/code elements.
 */
export function walkSemanticBlocks(
  root: Element,
  mediaRefs: ExtractedMediaReference[]
): ContentPart[] {
  const parts: ContentPart[] = [];

  function walk(node: Node): void {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const el = node as Element;
    const tag = el.tagName.toUpperCase();

    // 1. Code blocks: <pre> or element matching code block container
    if (isCodeBlockContainer(el)) {
      const { code, language } = extractCodeBlock(el);
      if (code) {
        parts.push({
          type: 'code',
          code,
          language,
        });
      }
      return;
    }

    // 2. Tables
    if (tag === 'TABLE') {
      const { headers, rows } = extractTableData(el);
      if (headers.length > 0 || rows.length > 0) {
        parts.push({
          type: 'table',
          headers,
          rows,
        });
      }
      return;
    }

    // 3. Headings: H1 - H6
    if (tag.startsWith('H') && tag.length === 2 && !isNaN(Number(tag[1]))) {
      const level = parseInt(tag[1]!, 10);
      const text = inlineElementToMarkdown(el);
      if (text) {
        parts.push({
          type: 'text',
          text: `${'#'.repeat(level)} ${text}`,
        });
      }
      return;
    }

    // 4. Blockquote
    if (tag === 'BLOCKQUOTE') {
      const text = el.textContent?.trim();
      if (text) {
        const quoted = text
          .split('\n')
          .map((line) => `> ${line.trim()}`)
          .join('\n');
        parts.push({
          type: 'text',
          text: quoted,
        });
      }
      return;
    }

    // 5. Lists (UL / OL)
    if (tag === 'UL' || tag === 'OL') {
      const hasComplexChildren = Boolean(
        el.querySelector('pre, table') ||
        Array.from(el.children).some((c) => isCodeBlockContainer(c))
      );
      if (hasComplexChildren) {
        for (const child of Array.from(el.childNodes)) {
          walk(child);
        }
        return;
      }

      const listItems = Array.from(el.querySelectorAll('li'));
      if (listItems.length > 0) {
        const listLines = listItems.map((li, idx) => {
          const liText = inlineElementToMarkdown(li);
          return tag === 'OL' ? `${idx + 1}. ${liText}` : `- ${liText}`;
        });
        parts.push({
          type: 'text',
          text: listLines.join('\n'),
        });
      }
      return;
    }

    // 6. Paragraphs
    if (tag === 'P') {
      if (isCodeBlockContainer(el) || el.querySelector('pre')) {
        for (const child of Array.from(el.childNodes)) {
          walk(child);
        }
        return;
      }
      const text = inlineElementToMarkdown(el);
      if (text) {
        parts.push({
          type: 'text',
          text,
        });
      }
      return;
    }

    // 7. Standalone Images / Generated Images
    if (tag === 'IMG') {
      const url = extractImageUrl(el);
      if (url && !isAvatarOrIcon(url, el)) {
        const alt = el.getAttribute('alt') || undefined;
        mediaRefs.push({
          url,
          role: 'assistant-generated',
          altText: alt,
          filename: alt ? `${alt.slice(0, 30)}.png` : undefined,
        });
        parts.push({
          type: 'image',
          blobSha256: url,
          altText: alt,
        });
      }
      return;
    }

    // 8. General container elements (DIV, SECTION, ARTICLE, etc.)
    const hasBlockChildren = Boolean(
      el.querySelector('p, pre, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote, img, code')
    );

    if (hasBlockChildren) {
      for (const child of Array.from(el.childNodes)) {
        walk(child);
      }
    } else {
      // Leaf container without block children: check text
      const text = inlineElementToMarkdown(el);
      if (text) {
        parts.push({
          type: 'text',
          text,
        });
      }
    }
  }

  for (const child of Array.from(root.childNodes)) {
    walk(child);
  }

  return parts;
}

/**
 * Extracts image URL from an element (checking currentSrc, src, srcset, data-src, background-image).
 */
export function extractImageUrl(el: Element): string | null {
  if ('currentSrc' in el && (el as HTMLImageElement).currentSrc) {
    const cs = (el as HTMLImageElement).currentSrc;
    if (cs && !cs.startsWith('data:image/svg')) return cs;
  }

  const src = el.getAttribute('src');
  if (src && !src.startsWith('data:image/svg')) return src;

  const srcset = el.getAttribute('srcset');
  if (srcset) {
    let candidate = '';
    if (srcset.startsWith('data:')) {
      const match = srcset.match(/^(data:[^,\s]+,[^\s]+)/);
      if (match) {
        candidate = match[1]!;
      }
    } else {
      candidate = srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';
    }
    if (candidate && !candidate.startsWith('data:image/svg')) {
      return candidate;
    }
  }

  const dataSrc = el.getAttribute('data-src') || el.getAttribute('data-original-src');
  if (dataSrc && !dataSrc.startsWith('data:image/svg')) return dataSrc;

  const style = el.getAttribute('style') || '';
  const bgMatch = style.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
  if (bgMatch && bgMatch[1] && !bgMatch[1].startsWith('data:image/svg')) {
    return bgMatch[1];
  }

  return null;
}

/**
 * Filters out UI icons and avatars.
 */
function isAvatarOrIcon(url: string, el: Element): boolean {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('avatar') || lowerUrl.includes('profile') || lowerUrl.includes('favicon')) {
    return true;
  }
  const alt = (el.getAttribute('alt') || '').toLowerCase();
  if (alt === 'user' || alt === 'chatgpt' || alt === 'assistant' || alt === 'profile') {
    return true;
  }
  const aria = (el.getAttribute('aria-label') || '').toLowerCase();
  if (aria.includes('avatar') || aria.includes('profile')) {
    return true;
  }
  return false;
}

function inferMimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function extractFilenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const base = pathname.split('/').filter(Boolean).pop();
    if (base && base.includes('.')) {
      return decodeURIComponent(base);
    }
  } catch {
    // Ignore
  }
  return 'attachment.bin';
}

const FILENAME_REGEX =
  /\b([\w.\-_ ]+\.(txt|pdf|ctxbridge|zip|json|csv|py|js|ts|html|css|xml|md|doc|docx|xls|xlsx|tar|gz|bz2|7z|bin|png|jpe?g|webp|gif|log|sh|yaml|yml|toml))\b/i;

export function isAttachmentSentinelText(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^\*?\(Attachment\)\*?$/i.test(trimmed) ||
    /^\[Attachment\]$/i.test(trimmed) ||
    /^\*?Attachment\*?$/i.test(trimmed) ||
    /^\(Attachment\)$/i.test(trimmed)
  );
}

export function parseUnitSlotIndex(unitKey: string): number | null {
  const match = unitKey.match(/:(\d+)(?::|$)/);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

export function sanitizeUrlForDiag(
  urlStr?: string | null
): { sanitizedUrl: string; kind: string } | null {
  if (!urlStr) return null;
  const trimmed = urlStr.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('blob:')) {
    return { sanitizedUrl: 'blob:...', kind: 'blob' };
  }
  if (trimmed.startsWith('data:')) {
    const mime = trimmed.slice(5, trimmed.indexOf(';')) || 'data:...';
    return {
      sanitizedUrl: `data:${mime};...`,
      kind: mime.startsWith('image/') ? 'data-image' : 'data-other',
    };
  }
  try {
    const u = new URL(trimmed);
    const kind = /files\.oaiusercontent\.com|backend-api\/files|chatgpt\.com\/files/i.test(
      u.hostname + u.pathname
    )
      ? 'http-chatgpt-file'
      : u.hostname.includes('chatgpt.com') || u.hostname.includes('openai.com')
      ? 'http-chatgpt'
      : 'http-external';
    // Strip query parameters to avoid leaking query tokens/signatures
    const cleanUrl = `${u.origin}${u.pathname}`;
    return { sanitizedUrl: cleanUrl, kind };
  } catch {
    return { sanitizedUrl: trimmed.slice(0, 60), kind: 'other' };
  }
}

export function extractSafeAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!el.attributes) return attrs;

  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i]!;
    const name = attr.name.toLowerCase();

    // Include all data-* attributes
    if (name.startsWith('data-')) {
      if (
        attr.value.startsWith('http') ||
        attr.value.startsWith('blob:') ||
        attr.value.startsWith('data:')
      ) {
        attrs[name] = sanitizeUrlForDiag(attr.value)?.sanitizedUrl || 'sanitized-url';
      } else {
        attrs[name] = attr.value.slice(0, 100);
      }
    }
    // Include specific semantic/accessibility attributes
    else if (
      name === 'role' ||
      name === 'aria-label' ||
      name === 'title' ||
      name === 'download' ||
      name === 'id' ||
      name === 'type' ||
      name === 'target'
    ) {
      attrs[name] = attr.value.slice(0, 100);
    }
    // Include class name truncated
    else if (name === 'class') {
      attrs['class'] = attr.value.slice(0, 80);
    }
    // Include href and src sanitized
    else if (name === 'href' || name === 'src') {
      const sanitized = sanitizeUrlForDiag(attr.value);
      if (sanitized) {
        attrs[name] = sanitized.sanitizedUrl;
      }
    }
  }

  return attrs;
}

export function extractFilenameCandidateText(el: Element): string | undefined {
  // Never dump conversational text paragraphs!
  // Only look for strings that look like a filename or file extension
  const text = el.textContent?.trim() || '';
  if (text.length > 1 && text.length < 80 && !text.includes('\n')) {
    const match = text.match(FILENAME_REGEX);
    if (match && match[1]) {
      return match[1].trim();
    }
    if (/\.[\w]{2,6}$/i.test(text)) {
      return text;
    }
  }
  return undefined;
}

function hasInterestingAttributes(el: Element): boolean {
  if (el.hasAttribute('href') || el.hasAttribute('src') || el.hasAttribute('download')) return true;
  if (
    el.hasAttribute('data-testid') ||
    el.hasAttribute('data-file-id') ||
    el.hasAttribute('data-file-name')
  ) {
    return true;
  }
  if (el.hasAttribute('aria-label') || el.hasAttribute('title') || el.hasAttribute('role')) {
    return true;
  }
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const n = el.attributes[i]!.name;
      if (n.startsWith('data-') && !n.startsWith('data-react')) return true;
    }
  }
  if (extractFilenameCandidateText(el)) return true;
  return false;
}

export function collectTurnStructuralDiagnostics(
  turnEl: Element,
  unitEl: Element,
  turnKey: string,
  unitKey?: string
): FileCardCandidateDiagnostic[] {
  const candidates: FileCardCandidateDiagnostic[] = [];
  const visited = new Set<Element>();

  function record(el: Element, relation: string) {
    if (visited.has(el)) return;
    visited.add(el);

    const safeAttrs = extractSafeAttributes(el);
    const hrefAttr = el.getAttribute('href');
    const srcAttr = el.getAttribute('src');
    const hrefInfo = sanitizeUrlForDiag(hrefAttr);
    const srcInfo = sanitizeUrlForDiag(srcAttr);
    const filenameCandidate = extractFilenameCandidateText(el);

    candidates.push({
      turnKey,
      unitKey,
      relationToUserUnit: relation,
      tagName: el.tagName.toLowerCase(),
      stableAttributes: safeAttrs,
      hrefKind: hrefInfo?.kind,
      srcKind: srcInfo?.kind,
      textFilenameCandidate: filenameCandidate,
    });
  }

  // 1. User unit itself
  record(unitEl, 'self');

  // 2. Parent of user unit
  if (unitEl.parentElement && unitEl.parentElement !== turnEl) {
    record(unitEl.parentElement, 'parent');
  }

  // 3. Grandparent of user unit
  if (unitEl.parentElement?.parentElement && unitEl.parentElement.parentElement !== turnEl) {
    record(unitEl.parentElement.parentElement, 'grandparent');
  }

  // 4. Siblings of user unit
  if (unitEl.parentElement) {
    const siblings = Array.from(unitEl.parentElement.children).filter((c) => c !== unitEl);
    for (const sib of siblings) {
      if (sib.matches?.(CHATGPT_SELECTORS.UNITS.ASSISTANT_FILTER)) continue;
      record(sib, 'sibling');

      // Also inspect children of sibling
      const sibChildren = Array.from(sib.querySelectorAll('*'));
      for (const sc of sibChildren) {
        if (hasInterestingAttributes(sc)) {
          record(sc, 'sibling-child');
        }
      }
    }
  }

  // 5. Descendants of user unit
  const unitDescendants = Array.from(unitEl.querySelectorAll('*'));
  for (const desc of unitDescendants) {
    if (hasInterestingAttributes(desc)) {
      record(desc, 'child');
    }
  }

  // 6. Turn-level descendants outside user unit and outside assistant units
  const turnDescendants = Array.from(turnEl.querySelectorAll('*'));
  for (const td of turnDescendants) {
    if (unitEl.contains(td) || td === unitEl) continue;
    if (
      td.closest?.(CHATGPT_SELECTORS.UNITS.ASSISTANT_FILTER) ||
      td.closest?.(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN) ||
      td.matches?.(CHATGPT_SELECTORS.UNITS.ASSISTANT_FILTER) ||
      td.matches?.(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN)
    ) {
      continue;
    }

    if (hasInterestingAttributes(td)) {
      record(td, 'turn-descendant');
    }
  }

  return candidates;
}

function extractFilenameFromCard(card: Element, linkInside?: Element | null): string {
  // 1. Explicit attributes
  const attrName =
    card.getAttribute('data-file-name') ||
    card.getAttribute('data-filename') ||
    linkInside?.getAttribute('download') ||
    linkInside?.getAttribute('data-file-name');
  if (attrName && attrName.trim()) return attrName.trim();

  // 2. Child elements with filename/title/truncate/name classes
  const namedEl = card.querySelector(
    '[class*="filename" i], [class*="title" i], [class*="name" i], [class*="truncate" i]'
  );
  const namedText = namedEl?.textContent?.trim();
  if (namedText) {
    const match = namedText.match(FILENAME_REGEX);
    if (match && match[1]) return match[1].trim();
  }

  // 3. Search child elements for text matching filename pattern
  const children = Array.from(card.querySelectorAll('span, div, p, a, strong, b'));
  for (const child of children) {
    const t = child.textContent?.trim() || '';
    if (t.length > 2 && t.length < 100 && !t.includes('\n')) {
      const match = t.match(FILENAME_REGEX);
      if (match && match[1]) return match[1].trim();
    }
  }

  // 4. Regex in full card textContent
  const fullText = card.textContent || '';
  const match = fullText.match(FILENAME_REGEX);
  if (match && match[1]) {
    return match[1].trim();
  }

  // 5. From link URL
  if (linkInside?.getAttribute('href')) {
    const fromUrl = extractFilenameFromUrl(linkInside.getAttribute('href')!);
    if (fromUrl !== 'attachment.bin') return fromUrl;
  }

  // 6. Reasonable card text snippet
  const text = card.textContent?.trim();
  if (text && text.length > 2 && text.length < 50 && !text.includes('\n')) {
    return text.replace(/\s+/g, '_');
  }

  return 'attachment.bin';
}

/**
 * Extracts media references and content parts from an element.
 */
function extractMediaFromContainer(
  container: Element,
  role: BlobRole,
  mediaRefs: ExtractedMediaReference[],
  seenUrls: Set<string>
): ContentPart[] {
  const parts: ContentPart[] = [];

  // 1. Check all img and picture and source elements
  const imageElements = Array.from(container.querySelectorAll('img, picture, source'));
  for (const imgEl of imageElements) {
    const url = extractImageUrl(imgEl);
    if (!url || seenUrls.has(url) || isAvatarOrIcon(url, imgEl)) continue;
    seenUrls.add(url);

    const alt = imgEl.getAttribute('alt') || undefined;
    const filename = alt
      ? alt.endsWith('.png') || alt.endsWith('.jpg')
        ? alt
        : `${alt.slice(0, 30)}.png`
      : 'image.png';

    mediaRefs.push({
      url,
      role,
      altText: alt,
      filename,
      mimeType: inferMimeFromFilename(filename),
    });
    parts.push({
      type: 'image',
      blobSha256: url,
      altText: alt,
    });
  }

  // 2. Check links with strong attachment evidence ONLY
  // Do NOT classify generic <a href> (such as console source links, CDN files, or documentation) as attachments
  const linkElements = Array.from(container.querySelectorAll('a[href]'));
  for (const a of linkElements) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || seenUrls.has(href)) continue;

    const hasDownloadAttr = a.hasAttribute('download');
    const isInAttachmentCard = Boolean(
      a.closest(
        '[data-testid*="attachment"], [data-testid*="file"], [aria-label*="attachment" i], [class*="attachment" i], [class*="file-card" i], [data-testid="file-card"], [data-testid="user-file-upload"]'
      )
    );
    const hasExplicitFileAttr =
      a.hasAttribute('data-file-id') ||
      a.hasAttribute('data-file-name') ||
      a.hasAttribute('data-attachment');
    const isBlobUpload = href.startsWith('blob:') && !isAvatarOrIcon(href, a);
    const isChatGPTFileUrl = /files\.oaiusercontent\.com|backend-api\/files|chatgpt\.com\/files/i.test(href);

    // Only treat as attachment if there is explicit attachment UI or upload evidence
    if (hasDownloadAttr || isInAttachmentCard || hasExplicitFileAttr || isBlobUpload || isChatGPTFileUrl) {
      seenUrls.add(href);
      const text = a.textContent?.trim();
      const filename =
        a.getAttribute('download') ||
        a.getAttribute('data-file-name') ||
        (text && text.length > 2 && !text.includes('\n') ? text : extractFilenameFromUrl(href));

      const lowerHref = href.toLowerCase();
      const isImage = /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(lowerHref) || lowerHref.includes('/images/');

      if (isImage) {
        mediaRefs.push({
          url: href,
          role,
          filename,
          mimeType: inferMimeFromFilename(filename),
        });
        parts.push({
          type: 'image',
          blobSha256: href,
          altText: filename,
        });
      } else {
        mediaRefs.push({
          url: href,
          role,
          filename,
          mimeType: inferMimeFromFilename(filename),
        });
        parts.push({
          type: 'file',
          blobSha256: href,
          filename,
          mimeType: inferMimeFromFilename(filename),
        });
      }
    }
  }

  // 3. Check attachment cards / containers (with or without anchor elements)
  const attachmentCards = Array.from(
    container.querySelectorAll(
      '[data-testid*="attachment"], [data-testid*="file"], [aria-label*="attachment" i], [class*="attachment" i], [class*="file-card" i], [data-testid="file-card"], [data-testid="user-file-upload"], [data-file-id], [data-file-name], [data-attachment-id]'
    )
  );

  // Filter out nested cards so we don't process both outer wrapper and inner card
  const topLevelCards = attachmentCards.filter((card) => {
    return !attachmentCards.some((other) => other !== card && other.contains(card));
  });

  for (const card of topLevelCards) {
    if (isAvatarOrIcon('', card)) continue;

    const imgInside = card.querySelector('img');
    const linkInside = card.querySelector('a[href]');

    // If card contains an img that was already captured, skip
    if (imgInside) {
      const imgUrl = extractImageUrl(imgInside);
      if (imgUrl && seenUrls.has(imgUrl)) continue;
    }
    // If card contains an a[href] that was already captured, skip
    if (linkInside) {
      const linkHref = linkInside.getAttribute('href');
      if (linkHref && seenUrls.has(linkHref)) continue;
    }

    const filename = extractFilenameFromCard(card, linkInside);
    const href = linkInside?.getAttribute('href');
    const dataUrl = card.getAttribute('data-file-url') || card.getAttribute('data-download-url');
    const buttonUrl = card.querySelector('[data-download-url]')?.getAttribute('data-download-url');
    const fileId = card.getAttribute('data-file-id') || card.getAttribute('data-attachment-id') || card.id;

    let url = href || dataUrl || buttonUrl;
    if (!url) {
      url = fileId ? `chatgpt-file://${fileId}/${filename}` : `chatgpt-file://${filename}`;
    }

    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    const mimeType = inferMimeFromFilename(filename);
    const isImage =
      /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(filename) ||
      /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(url);

    if (isImage) {
      mediaRefs.push({
        url,
        role,
        filename,
        mimeType,
        altText: filename,
      });
      parts.push({
        type: 'image',
        blobSha256: url,
        altText: filename,
      });
    } else {
      mediaRefs.push({
        url,
        role,
        filename,
        mimeType,
      });
      parts.push({
        type: 'file',
        blobSha256: url,
        filename,
        mimeType,
      });
    }
  }

  return parts;
}

/**
 * Parses user message container, extracting text and attachments/media.
 * Inspects unitEl and optional parent/sibling turnEl to catch media siblings.
 */
function parseUserContent(
  unitEl: Element,
  mediaRefs: ExtractedMediaReference[],
  turnEl?: Element,
  detectedFileCards?: DetectedUserFileCard[],
  turnKey?: string
): ContentPart[] {
  const parts: ContentPart[] = [];
  const seenUrls = new Set<string>();

  // 1. Extract media directly from unitEl
  const unitMediaParts = extractMediaFromContainer(unitEl, 'user-upload', mediaRefs, seenUrls);
  parts.push(...unitMediaParts);

  // 2. Also check turnEl for user uploads outside assistant units
  if (turnEl) {
    const cloneTurn = turnEl.cloneNode(true) as Element;
    cloneTurn.querySelectorAll(CHATGPT_SELECTORS.UNITS.ASSISTANT_FILTER).forEach((asst) => asst.remove());
    cloneTurn.querySelectorAll(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN).forEach((asst) => asst.remove());
    cloneTurn.querySelectorAll(CHATGPT_SELECTORS.CONTENT.MARKDOWN_PROSE).forEach((asst) => asst.remove());
    const turnMediaParts = extractMediaFromContainer(cloneTurn, 'user-upload', mediaRefs, seenUrls);
    parts.push(...turnMediaParts);
  }

  // 3. Authoritative user file card detection (resource-card buttons in user turn container / siblings)
  const rootForCards = turnEl || unitEl.parentElement || unitEl;
  // Pass the real turn key so cards are keyed per turn (same filename in two turns = two cards).
  const cards = findUserFileCards(rootForCards, unitEl, turnKey);
  if (cards.length > 0) {
    if (detectedFileCards) {
      detectedFileCards.push(...cards);
    }
    for (const card of cards) {
      const fileRefUrl = `chatgpt-file://${card.filename}`;
      if (!seenUrls.has(fileRefUrl) && !seenUrls.has(card.filename)) {
        seenUrls.add(fileRefUrl);
        seenUrls.add(card.filename);
        const mime = inferMimeFromFilename(card.filename);
        mediaRefs.push({
          url: fileRefUrl,
          role: 'user-upload',
          filename: card.filename,
          mimeType: mime,
        });
        parts.push({
          type: 'file',
          blobSha256: fileRefUrl,
          filename: card.filename,
          mimeType: mime,
        });
      }
    }
  }

  // 3. User text
  const paragraphs = unitEl.querySelectorAll('p');
  if (paragraphs.length > 0) {
    paragraphs.forEach((p) => {
      // Don't treat text inside attachment cards as user message paragraphs
      if (
        p.closest(
          '[data-testid*="attachment"], [data-testid*="file"], [aria-label*="attachment" i], [class*="attachment" i], [class*="file-card" i], [data-testid="file-card"], [data-testid="user-file-upload"], [data-file-id], [data-file-name]'
        )
      ) {
        return;
      }
      const text = inlineElementToMarkdown(p);
      if (text) {
        parts.push({
          type: 'text',
          text,
        });
      }
    });
  } else {
    // If no <p> tags, clone and strip non-content UI
    const clone = unitEl.cloneNode(true) as Element;
    clone
      .querySelectorAll(
        'button, svg, [data-testid*="attachment"], [data-testid*="file"], [aria-label*="attachment" i], [class*="attachment" i], [class*="file-card" i], [data-testid="file-card"], [data-testid="user-file-upload"], [data-file-id], [data-file-name], img, picture'
      )
      .forEach((el) => {
        el.remove();
      });
    const text = clone.textContent?.trim();
    if (text) {
      parts.push({
        type: 'text',
        text,
      });
    }
  }

  return parts;
}

/**
 * Consolidates consecutive text parts only.
 * Preserves code, table, and media parts in strict order.
 */
function consolidateTextParts(parts: ContentPart[]): ContentPart[] {
  const consolidated: ContentPart[] = [];
  for (const part of parts) {
    const last = consolidated[consolidated.length - 1];
    if (part.type === 'text' && last?.type === 'text') {
      last.text += '\n\n' + part.text;
    } else {
      consolidated.push(part);
    }
  }
  return consolidated;
}

/**
 * Extracts turn key from an element.
 * Prioritizes [data-turn-key] (stable UUID).
 * Uses data-content-search-turn-key only as fallback when data-turn-key is absent.
 */
export function getTurnKeyFromElement(el: Element, fallbackIdx: number): string {
  // 1. Authoritative: data-turn-key (stable UUID)
  const turnKey =
    el.getAttribute('data-turn-key') ||
    el.querySelector('[data-turn-key]')?.getAttribute('data-turn-key') ||
    el.closest('[data-turn-key]')?.getAttribute('data-turn-key');
  if (turnKey) return turnKey;

  // 2. data-content-search-turn-key
  const contentSearchTurnKey =
    el.getAttribute('data-content-search-turn-key') ||
    el.querySelector('[data-content-search-turn-key]')?.getAttribute('data-content-search-turn-key');
  if (contentSearchTurnKey) return contentSearchTurnKey;

  // 3. Fallback from unitKey
  const unitKey =
    el.querySelector(CHATGPT_SELECTORS.UNITS.PRIMARY)?.getAttribute('data-content-search-unit-key') ||
    el.querySelector(CHATGPT_SELECTORS.UNITS.FALLBACK)?.getAttribute('data-chatgpt-search-unit-key');
  if (unitKey) {
    const match = unitKey.match(/((?:fallback-)?turn-\d+)/i);
    if (match && match[1]) return match[1];
  }

  return el.getAttribute('data-testid') || `turn-${fallbackIdx}`;
}

export function parseTurnNumber(key: string): number | null {
  const turnMatch = key.match(/(?:fallback-)?turn[^\d]*(\d+)/i);
  if (turnMatch && turnMatch[1]) {
    return parseInt(turnMatch[1], 10);
  }
  const msgMatch = key.match(/msg[^\d]*(\d+)/i);
  if (msgMatch && msgMatch[1]) {
    return parseInt(msgMatch[1], 10);
  }
  return null;
}

/**
 * Extracts a message from a single semantic unit element.
 */
export function extractChatGPTUnit(
  unitEl: Element,
  sequenceIndex: number,
  turnKey?: string,
  turnEl?: Element,
  intraTurnRoleIndex: number = 0
): ExtractedMessageResult | null {
  const unitKey =
    unitEl.getAttribute('data-content-search-unit-key') ||
    unitEl.getAttribute('data-chatgpt-search-unit-key') ||
    '';

  // Role detection
  let role: MessageRole = 'user';
  let originalRoleToken: string | undefined;

  if (unitKey) {
    const parsed = parseRoleFromUnitKey(unitKey);
    role = parsed.role;
    originalRoleToken = parsed.originalRoleToken;
  } else {
    const roleAttr =
      unitEl.getAttribute('data-message-author-role') ||
      unitEl.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
    if (roleAttr === 'assistant' || roleAttr === 'user' || roleAttr === 'system' || roleAttr === 'tool') {
      role = roleAttr;
    } else {
      const hasMarkdown = Boolean(
        unitEl.querySelector(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN) ||
        unitEl.querySelector(CHATGPT_SELECTORS.CONTENT.MARKDOWN_PROSE)
      );
      role = hasMarkdown ? 'assistant' : 'user';
    }
  }

  // Stable message ID determination:
  // 1. Provider message ID if available (e.g. selection or search message ID for assistant messages)
  const providerId = extractMessageId(unitEl, '');
  let messageId: string;
  if (providerId) {
    messageId = providerId;
  } else if (turnKey) {
    // 2. Stable turn UUID + role + intra-turn role index (NEVER use unstable fallback-turn-N)
    messageId = intraTurnRoleIndex > 0 ? `${turnKey}:${role}:${intraTurnRoleIndex}` : `${turnKey}:${role}`;
  } else if (unitKey) {
    // 3. Fallback when neither provider ID nor turnKey exists
    messageId = unitKey;
  } else {
    messageId = `chatgpt-msg-${sequenceIndex}`;
  }

  const detectedFileCards: DetectedUserFileCard[] = [];
  const mediaRefs: ExtractedMediaReference[] = [];
  let contentParts: ContentPart[] = [];

  if (role === 'assistant') {
    // Target the assistant root container that encompasses all blocks
    const assistantRoot =
      unitEl.querySelector(CHATGPT_SELECTORS.IDENTIFIERS.SELECTION_MESSAGE_ID) ||
      unitEl.querySelector(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN) ||
      unitEl.querySelector(CHATGPT_SELECTORS.CONTENT.MARKDOWN_PROSE) ||
      unitEl;
    contentParts = walkSemanticBlocks(assistantRoot, mediaRefs);
  } else {
    contentParts = parseUserContent(unitEl, mediaRefs, turnEl, detectedFileCards, turnKey);
  }

  const consolidatedParts = consolidateTextParts(contentParts);
  const slotIndex =
    parseUnitSlotIndex(unitKey) ??
    (role === 'user' ? intraTurnRoleIndex * 2 : intraTurnRoleIndex * 2 + 1);

  // Check if content is solely an attachment sentinel (e.g. "*(Attachment)*") without real media
  const hasRealContent = consolidatedParts.some(
    (p) =>
      p.type === 'image' ||
      p.type === 'file' ||
      (p.type === 'text' && !isAttachmentSentinelText(p.text))
  );

  const isSentinel = role === 'user' && !hasRealContent;

  const metadata: Record<string, unknown> = {};
  if (unitKey) metadata.unitKey = unitKey;
  if (turnKey) metadata.turnKey = turnKey;
  if (originalRoleToken) metadata.originalRoleToken = originalRoleToken;

  if (consolidatedParts.length === 0 || isSentinel) {
    if (role === 'user') {
      // Collect structural diagnostics for the user unit and surrounding turn while mounted
      const structuralCandidates = turnEl
        ? collectTurnStructuralDiagnostics(turnEl, unitEl, turnKey || 'unknown', unitKey)
        : [];

      // DANGEROUS FALLBACK REMOVED: Do NOT emit *(Attachment)* as text.
      // Mark as unresolved attachment so the crawler can fail closed and report diagnostics.
      return {
        message: {
          id: messageId,
          role: 'user',
          sequence: sequenceIndex,
          content: [], // Empty content marks unit as unresolved
          metadata: {
            ...metadata,
            unitKey: unitKey || undefined,
            turnKey: turnKey || undefined,
            isAttachmentSentinel: true,
          },
        },
        mediaRefs: [],
        intraTurnIndex: slotIndex,
        isAttachmentSentinel: true,
        isUnresolvedAttachment: true,
        structuralCandidates,
        detectedFileCards: detectedFileCards.length > 0 ? detectedFileCards : undefined,
      };
    } else {
      return null;
    }
  }

  return {
    message: {
      id: messageId,
      role,
      sequence: sequenceIndex,
      content: consolidatedParts,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    },
    mediaRefs,
    intraTurnIndex: slotIndex,
    detectedFileCards: detectedFileCards.length > 0 ? detectedFileCards : undefined,
  };
}

/**
 * Legacy extractor for turns without semantic units (e.g. older ChatGPT DOM / test fixtures).
 */
function extractChatGPTLegacyTurn(
  turnEl: Element,
  sequenceIndex: number
): ExtractedMessageResult | null {
  let role: MessageRole = 'user';
  const roleEl = turnEl.querySelector(CHATGPT_SELECTORS.ROLES.ATTRIBUTE);
  const roleAttr = roleEl?.getAttribute('data-message-author-role') || turnEl.getAttribute('data-message-author-role');

  if (roleAttr === 'assistant') {
    role = 'assistant';
  } else if (roleAttr === 'user') {
    role = 'user';
  } else {
    const heading = turnEl.querySelector('h5, h6, [class*="author"]')?.textContent?.toLowerCase() || '';
    if (heading.includes('chatgpt') || heading.includes('assistant')) {
      role = 'assistant';
    } else if (heading.includes('you')) {
      role = 'user';
    } else {
      const hasProse = turnEl.querySelector(CHATGPT_SELECTORS.CONTENT.MARKDOWN_PROSE);
      role = hasProse ? 'assistant' : 'user';
    }
  }

  const testId = turnEl.getAttribute('data-testid');
  const turnKey = getTurnKeyFromElement(turnEl, sequenceIndex);
  const fallbackId = turnKey ? `${turnKey}:${role}` : (testId || `chatgpt-turn-${sequenceIndex}`);
  const stableId = extractMessageId(turnEl, fallbackId);

  const mediaRefs: ExtractedMediaReference[] = [];
  let contentParts: ContentPart[] = [];
  if (role === 'assistant') {
    contentParts = walkSemanticBlocks(turnEl, mediaRefs);
  } else {
    contentParts = parseUserContent(turnEl, mediaRefs);
  }

  const consolidatedParts = consolidateTextParts(contentParts);
  if (consolidatedParts.length === 0) {
    return null;
  }

  return {
    message: {
      id: stableId,
      role,
      sequence: sequenceIndex,
      content: consolidatedParts,
    },
    mediaRefs,
    intraTurnIndex: role === 'user' ? 0 : 2,
  };
}

/**
 * Extracts all message units from a turn element.
 */
export function extractChatGPTTurn(
  turnEl: Element,
  startSequenceIndex: number
): ExtractedMessageResult[] {
  const turnKey = getTurnKeyFromElement(turnEl, startSequenceIndex);

  let unitElements = Array.from(turnEl.querySelectorAll(CHATGPT_SELECTORS.UNITS.PRIMARY));
  if (unitElements.length === 0) {
    unitElements = Array.from(turnEl.querySelectorAll(CHATGPT_SELECTORS.UNITS.FALLBACK));
  }

  if (unitElements.length > 0) {
    const results: ExtractedMessageResult[] = [];
    const roleCounts = new Map<MessageRole, number>();
    let seq = startSequenceIndex;

    for (const unitEl of unitElements) {
      const unitKey =
        unitEl.getAttribute('data-content-search-unit-key') ||
        unitEl.getAttribute('data-chatgpt-search-unit-key') ||
        '';
      let role: MessageRole = 'user';
      if (unitKey) {
        role = parseRoleFromUnitKey(unitKey).role;
      } else {
        const roleAttr =
          unitEl.getAttribute('data-message-author-role') ||
          unitEl.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
        if (roleAttr === 'assistant' || roleAttr === 'user' || roleAttr === 'system' || roleAttr === 'tool') {
          role = roleAttr;
        } else {
          const hasMarkdown = Boolean(
            unitEl.querySelector(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN) ||
            unitEl.querySelector(CHATGPT_SELECTORS.CONTENT.MARKDOWN_PROSE)
          );
          role = hasMarkdown ? 'assistant' : 'user';
        }
      }

      const roleIndex = roleCounts.get(role) ?? 0;
      roleCounts.set(role, roleIndex + 1);

      const extracted = extractChatGPTUnit(unitEl, seq, turnKey, turnEl, roleIndex);
      if (extracted) {
        results.push(extracted);
        seq++;
      }
    }

    // Turn Completeness Validation for this turn:
    // If the turn contains an assistant response, verify whether a user message was extracted.
    const hasAssistant = results.some((r) => r.message.role === 'assistant');
    const hasUser = results.some((r) => r.message.role === 'user');

    if (hasAssistant && !hasUser) {
      // Check turnEl for user content or media outside assistant units
      const cloneTurn = turnEl.cloneNode(true) as Element;
      cloneTurn.querySelectorAll(CHATGPT_SELECTORS.UNITS.ASSISTANT_FILTER).forEach((asst) => asst.remove());
      cloneTurn.querySelectorAll(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN).forEach((asst) => asst.remove());
      cloneTurn.querySelectorAll(CHATGPT_SELECTORS.CONTENT.MARKDOWN_PROSE).forEach((asst) => asst.remove());

      const userMediaRefs: ExtractedMediaReference[] = [];
      const detectedFileCards: DetectedUserFileCard[] = [];
      const userParts = parseUserContent(cloneTurn, userMediaRefs, turnEl, detectedFileCards, turnKey);
      const realParts = userParts.filter(
        (p) =>
          p.type === 'file' ||
          p.type === 'image' ||
          (p.type === 'text' && !isAttachmentSentinelText(p.text))
      );

      if (realParts.length > 0) {
        const userMsg: ExtractedMessageResult = {
          message: {
            id: `${turnKey}:user`,
            role: 'user',
            sequence: startSequenceIndex,
            content: consolidateTextParts(realParts),
            metadata: { turnKey, synthesizedFromTurn: true },
          },
          mediaRefs: userMediaRefs,
          intraTurnIndex: 0,
          detectedFileCards: detectedFileCards.length > 0 ? detectedFileCards : undefined,
        };
        results.unshift(userMsg);
      } else {
        const hasUserIndicator = Boolean(
          turnEl.querySelector(CHATGPT_SELECTORS.UNITS.USER_FILTER) ||
          turnEl.querySelector('[data-message-author-role="user"]') ||
          turnEl.querySelector('[data-testid*="file"], [data-file-id], [data-file-name]') ||
          (cloneTurn.textContent && isAttachmentSentinelText(cloneTurn.textContent))
        );

        if (hasUserIndicator) {
          // Collect structural diagnostics for the unresolved turn
          const userUnitEl =
            unitElements.find((u) => {
              const k =
                u.getAttribute('data-content-search-unit-key') ||
                u.getAttribute('data-chatgpt-search-unit-key');
              return k?.endsWith(':user');
            }) ||
            unitElements[0] ||
            turnEl;

          const diagCandidates = collectTurnStructuralDiagnostics(
            turnEl,
            userUnitEl,
            turnKey,
            userUnitEl.getAttribute('data-content-search-unit-key') || undefined
          );

          // Mark as unresolved sentinel user unit
          const sentinelMsg: ExtractedMessageResult = {
            message: {
              id: `${turnKey}:user`,
              role: 'user',
              sequence: startSequenceIndex,
              content: [],
              metadata: { turnKey, isAttachmentSentinel: true },
            },
            mediaRefs: [],
            intraTurnIndex: 0,
            isAttachmentSentinel: true,
            isUnresolvedAttachment: true,
            structuralCandidates: diagCandidates,
          };
          results.unshift(sentinelMsg);
        }
      }
    }

    // Merge any turn-level user file cards into the user message
    const userMsgResult = results.find((r) => r.message.role === 'user');
    if (userMsgResult) {
      const turnCards = findUserFileCards(turnEl, undefined, turnKey);
      if (turnCards.length > 0) {
        if (!userMsgResult.detectedFileCards) {
          userMsgResult.detectedFileCards = [];
        }
        for (const tc of turnCards) {
          if (!userMsgResult.detectedFileCards.some((c) => c.filename === tc.filename)) {
            userMsgResult.detectedFileCards.push(tc);
            const fileRefUrl = `chatgpt-file://${tc.filename}`;
            userMsgResult.mediaRefs.push({
              url: fileRefUrl,
              role: 'user-upload',
              filename: tc.filename,
              mimeType: inferMimeFromFilename(tc.filename),
            });
            userMsgResult.message.content.push({
              type: 'file',
              blobSha256: fileRefUrl,
              filename: tc.filename,
              mimeType: inferMimeFromFilename(tc.filename),
            });
          }
        }
      }
    }

    // Intra-turn ordering:
    // Sort all messages inside the turn strictly by intraTurnIndex (User before Assistant)
    results.sort((a, b) => {
      const slotA = a.intraTurnIndex ?? (a.message.role === 'user' ? 0 : 2);
      const slotB = b.intraTurnIndex ?? (b.message.role === 'user' ? 0 : 2);
      if (slotA !== slotB) return slotA - slotB;
      if (a.message.role === 'user' && b.message.role !== 'user') return -1;
      if (a.message.role !== 'user' && b.message.role === 'user') return 1;
      return 0;
    });

    return results;
  }

  // Fallback to legacy turn extraction
  const legacy = extractChatGPTLegacyTurn(turnEl, startSequenceIndex);
  return legacy ? [legacy] : [];
}

/**
 * Extracts a single message from an element (turn or unit).
 * Kept for backward compatibility.
 */
export function extractChatGPTMessage(
  turnOrUnitEl: Element,
  sequenceIndex: number
): ExtractedMessageResult | null {
  const isUnit =
    turnOrUnitEl.hasAttribute('data-content-search-unit-key') ||
    turnOrUnitEl.hasAttribute('data-chatgpt-search-unit-key');

  if (isUnit) {
    return extractChatGPTUnit(turnOrUnitEl, sequenceIndex);
  }

  const extractedList = extractChatGPTTurn(turnOrUnitEl, sequenceIndex);
  return extractedList[0] || null;
}
