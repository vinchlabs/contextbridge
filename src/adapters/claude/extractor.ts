/**
 * DOM extractor for Claude messages
 */

import {
  Message,
  MessageRole,
  ContentPart,
} from '../../core/model/canonical';
import { extractTableData, topLevelMatches, contentFingerprint } from '../../utils/dom';
import { CLAUDE_SELECTORS } from './selectors';
import { ExtractedMediaReference, ExtractedMessageResult } from '../chatgpt/extractor';

export function extractClaudeMessage(
  turnEl: Element,
  sequenceIndex: number
): ExtractedMessageResult | null {
  let role: MessageRole = 'assistant';
  if (
    turnEl.matches(CLAUDE_SELECTORS.TURNS.USER) ||
    turnEl.querySelector(CLAUDE_SELECTORS.TURNS.USER) ||
    turnEl.className.includes('font-user-message')
  ) {
    role = 'user';
  }

  // data-testid is a constant ("user-message") and the DOM index shifts when history loads, so
  // neither identifies a message. Use a provider id when present, else a content fingerprint.
  const providerId = turnEl.getAttribute('data-message-id') || turnEl.getAttribute('id');
  const stableId = providerId
    ? `claude-${providerId}`
    : `claude-${role}-${contentFingerprint(turnEl.textContent || '')}`;
  const contentParts: ContentPart[] = [];
  const mediaRefs: ExtractedMediaReference[] = [];

  const bodyEl = turnEl.querySelector(CLAUDE_SELECTORS.CONTENT.PROSE) || turnEl;

  // Extract images
  const imgs = turnEl.querySelectorAll(CLAUDE_SELECTORS.CONTENT.IMAGES);
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

  // Extract file attachments
  const attachments = turnEl.querySelectorAll(CLAUDE_SELECTORS.CONTENT.ATTACHMENTS);
  attachments.forEach((att, idx) => {
    const filename = att.textContent?.trim() || `attachment-${idx + 1}`;
    const link = att.querySelector('a[href]')?.getAttribute('href');
    if (link) {
      mediaRefs.push({
        url: link,
        role: 'user-upload',
        filename,
      });
      contentParts.push({
        type: 'file',
        blobSha256: link,
        filename,
        mimeType: 'application/octet-stream',
      });
    }
  });

  // Extract code blocks and artifacts
  // Outermost matches only: 'pre, pre code' would otherwise emit every block twice.
  const codeBlocks = topLevelMatches(bodyEl, CLAUDE_SELECTORS.CONTENT.CODE_BLOCKS);
  codeBlocks.forEach((cb) => {
    const codeEl = cb.querySelector('code') || cb;
    const codeText = codeEl.textContent || '';
    const lang = codeEl.className.match(/language-(\w+)/)?.[1];

    contentParts.push({
      type: 'code',
      code: codeText,
      language: lang,
    });
  });

  // Extract tables
  const tables = bodyEl.querySelectorAll(CLAUDE_SELECTORS.CONTENT.TABLES);
  tables.forEach((table) => {
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
      if (el.closest('pre') || el.closest('table')) return;
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
