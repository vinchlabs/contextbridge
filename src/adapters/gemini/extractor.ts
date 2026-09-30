/**
 * DOM extractor for Google Gemini messages
 */

import {
  Message,
  MessageRole,
  ContentPart,
} from '../../core/model/canonical';
import { extractTableData, topLevelMatches, contentFingerprint } from '../../utils/dom';
import { GEMINI_SELECTORS } from './selectors';
import { ExtractedMediaReference, ExtractedMessageResult } from '../chatgpt/extractor';

export function extractGeminiMessage(
  turnEl: Element,
  sequenceIndex: number
): ExtractedMessageResult | null {
  // Determine role
  let role: MessageRole = 'assistant';
  const tag = turnEl.tagName.toLowerCase();
  const className = turnEl.className || '';

  if (tag === 'user-query' || className.includes('user-query')) {
    role = 'user';
  } else {
    role = 'assistant';
  }

  // The positional fallback (`gemini-turn-${index}`) collided as soon as older turns were
  // prepended; prefer real ids, then the turn container id, then a content fingerprint.
  const ownId = turnEl.getAttribute('id');
  const containerId = turnEl.closest('.conversation-container')?.getAttribute('id');
  const stableId = ownId
    ? `gemini-${ownId}`
    : containerId
      ? `gemini-${containerId}:${role}`
      : `gemini-${role}-${contentFingerprint(turnEl.textContent || '')}`;
  const contentParts: ContentPart[] = [];
  const mediaRefs: ExtractedMediaReference[] = [];

  const bodyEl = turnEl.querySelector(GEMINI_SELECTORS.CONTENT.BODY) || turnEl;

  // Extract images
  const imgs = turnEl.querySelectorAll(GEMINI_SELECTORS.CONTENT.IMAGES);
  imgs.forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:image/svg')) return;
    const alt = img.getAttribute('alt') || undefined;

    mediaRefs.push({
      url: src,
      role: role === 'assistant' ? 'assistant-generated' : 'user-upload',
      altText: alt,
    });

    contentParts.push({
      type: 'image',
      blobSha256: src,
      altText: alt,
    });
  });

  // Extract code blocks
  // Outermost matches only: 'code-block, pre, .code-block' matches one block up to 3 times.
  const codeBlocks = topLevelMatches(bodyEl, GEMINI_SELECTORS.CONTENT.CODE_BLOCKS);
  const handledCodeElements = new Set<Element>();
  codeBlocks.forEach((cb) => {
    handledCodeElements.add(cb);
    const codeEl = cb.querySelector('code') || cb;
    const codeText = codeEl.textContent || '';
    const lang = cb.getAttribute('language') || cb.className.match(/language-(\w+)/)?.[1];

    contentParts.push({
      type: 'code',
      code: codeText,
      language: lang,
    });
  });

  // Extract tables
  const tables = bodyEl.querySelectorAll(GEMINI_SELECTORS.CONTENT.TABLES);
  const handledTableElements = new Set<Element>();
  tables.forEach((table) => {
    handledTableElements.add(table);
    const { headers, rows } = extractTableData(table);
    if (headers.length > 0 || rows.length > 0) {
      contentParts.push({
        type: 'table',
        headers,
        rows,
      });
    }
  });

  // Extract text
  // Top-level text blocks only: an <li> containing a <p> (or a nested list) is emitted once.
  const textElements = topLevelMatches(bodyEl, 'p, li, h1, h2, h3, h4, h5, h6');
  if (textElements.length > 0) {
    textElements.forEach((el) => {
      // Don't include text from code blocks or tables
      if (el.closest('pre') || el.closest('code-block') || el.closest('table')) return;
      const text = el.textContent?.trim();
      if (text) {
        contentParts.push({
          type: 'text',
          text,
        });
      }
    });
  } else {
    const text = bodyEl.textContent?.trim() || '';
    if (text) {
      contentParts.push({
        type: 'text',
        text,
      });
    }
  }

  // Consolidate text parts
  const consolidated: ContentPart[] = [];
  for (const part of contentParts) {
    const last = consolidated[consolidated.length - 1];
    if (part.type === 'text' && last?.type === 'text') {
      last.text += '\n\n' + part.text;
    } else {
      consolidated.push(part);
    }
  }

  if (consolidated.length === 0) {
    return null;
  }

  return {
    message: {
      id: stableId,
      role,
      sequence: sequenceIndex,
      content: consolidated,
    },
    mediaRefs,
  };
}
