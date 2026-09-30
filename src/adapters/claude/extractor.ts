/**
 * DOM extractor for Claude messages. Only the fallback when claude.ai's conversation API is not
 * available (see api-capture.ts): the page shows the loaded messages, read in document order.
 */

import { MessageRole, ContentPart } from '../../core/model/canonical';
import { mimeForFilename } from '../../core/model/attachments';
import { contentFingerprint } from '../../utils/dom';
import { walkMessageContent } from '../content-walker';
import { CLAUDE_SELECTORS } from './selectors';
import { ExtractedMediaReference, ExtractedMessageResult } from '../chatgpt/extractor';

/** Claude page chrome inside a message: thinking summaries, action bars, feedback. */
const CLAUDE_CHROME = [
  '[data-testid*="thinking"]',
  '[data-testid*="action-bar"]',
  '[data-testid*="feedback"]',
  '[role="toolbar"]',
  '[role="menu"]',
  '[role="tooltip"]',
].join(', ');

function isClaudeChrome(el: Element): boolean {
  try {
    return el.matches(CLAUDE_CHROME);
  } catch {
    return false;
  }
}

export function extractClaudeMessage(turnEl: Element, sequenceIndex: number): ExtractedMessageResult | null {
  const className = typeof turnEl.className === 'string' ? turnEl.className : '';
  const role: MessageRole =
    turnEl.matches(CLAUDE_SELECTORS.TURNS.USER) ||
    !!turnEl.querySelector(CLAUDE_SELECTORS.TURNS.USER) ||
    className.includes('font-user-message')
      ? 'user'
      : 'assistant';

  // data-testid is a constant ("user-message") and the DOM index shifts when history loads, so
  // neither identifies a message. Use a provider id when present, else a content fingerprint.
  const providerId = turnEl.getAttribute('data-message-id') || turnEl.getAttribute('id');
  const stableId = providerId
    ? `claude-${providerId}`
    : `claude-${role}-${contentFingerprint(turnEl.textContent || '')}`;
  const mediaRefs: ExtractedMediaReference[] = [];

  // Attachment cards that link their file.
  const attachmentEls = new Set<Element>();
  const attachmentParts: ContentPart[] = [];
  turnEl.querySelectorAll(CLAUDE_SELECTORS.CONTENT.ATTACHMENTS).forEach((att, idx) => {
    if (Array.from(attachmentEls).some((a) => a.contains(att))) return;
    const href = att.querySelector('a[href]')?.getAttribute('href');
    if (!href) return;
    attachmentEls.add(att);
    const filename = att.textContent?.trim() || `attachment-${idx + 1}`;
    const mimeType = mimeForFilename(filename) || 'application/octet-stream';
    mediaRefs.push({ url: href, role: 'user-upload', filename, mimeType });
    attachmentParts.push({ type: 'file', blobSha256: href, filename, mimeType });
  });

  const parts = walkMessageContent(turnEl, mediaRefs, {
    role: role === 'user' ? 'user-upload' : 'assistant-generated',
    skip: (el) => attachmentEls.has(el) || isClaudeChrome(el),
  });
  const content = [...attachmentParts, ...parts];
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
