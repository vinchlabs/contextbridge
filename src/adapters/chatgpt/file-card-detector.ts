/**
 * Authoritative detector for ChatGPT user uploaded-file cards.
 * Operates strictly scoped to the user side of a conversation turn.
 */

import { CHATGPT_SELECTORS } from './selectors';

export interface DetectedUserFileCard {
  buttonEl: HTMLButtonElement | Element;
  filename: string;
  ariaLabel: string;
  spanTitle?: string;
  turnKey: string;
  unitKey?: string;
  isResourceCardClass: boolean;
}

const ACTION_PHRASES = [
  'edit message',
  'copy message',
  'read aloud',
  'bad response',
  'good response',
  'thumbs up',
  'thumbs down',
  'switch model',
  'regenerate',
  'more options',
  'share chat',
  'close modal',
  'close dialog',
  'attach files',
  'send message',
  'open sidebar',
  'close sidebar',
  'scroll to bottom',
  'download code',
  'view source',
];

/**
 * Checks if a string looks like a plausible user-uploaded filename.
 */
export function isPlausibleFilename(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 200 || trimmed.includes('\n')) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  for (const phrase of ACTION_PHRASES) {
    if (lower === phrase || lower.startsWith(phrase + ' ') || lower.endsWith(' ' + phrase)) {
      return false;
    }
  }

  // Must have an extension matching common or plausible extensions:
  // e.g. .ctxbridge, .txt, .png, .jpg, .pdf, .json, .csv, .py, etc.
  if (/\.([a-zA-Z0-9_-]{1,15})(\?.*)?$/i.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Finds all uploaded file cards on the user side of a turn element.
 *
 * Primary criteria:
 * 1. element is a BUTTON
 * 2. located in the user side of the same [data-turn-key]
 * 3. outside assistant subtrees
 * 4. sibling/sibling-descendant of user-message container or within user side of turn
 * 5. plausible filename in aria-label
 * 6. preferably contains a descendant span whose title equals the same filename
 */
export function findUserFileCards(
  turnRoot: Element,
  userUnit?: Element,
  turnKey: string = 'unknown'
): DetectedUserFileCard[] {
  const cards: DetectedUserFileCard[] = [];
  const visitedButtons = new Set<Element>();

  // 1. Collect candidate button elements within turnRoot
  const allButtons = Array.from(turnRoot.querySelectorAll('button'));

  for (const btn of allButtons) {
    if (visitedButtons.has(btn)) continue;

    // 2. Reject buttons inside assistant subtrees
    if (
      btn.closest(CHATGPT_SELECTORS.UNITS.ASSISTANT_FILTER) ||
      btn.closest(CHATGPT_SELECTORS.CONTENT.ASSISTANT_MARKDOWN) ||
      btn.closest('.agent-turn') ||
      btn.closest('[data-message-author-role="assistant"]')
    ) {
      continue;
    }

    // 3. Reject buttons that are part of standard assistant action bars
    if (
      btn.closest('[data-testid*="feedback"]') ||
      btn.closest('[data-testid*="copy"]') ||
      btn.closest('[data-testid*="speech"]')
    ) {
      continue;
    }

    // 4. Extract aria-label
    const ariaLabel = btn.getAttribute('aria-label')?.trim() || '';
    if (!ariaLabel) continue;

    // 5. Check descendant span with title
    const titleSpan = btn.querySelector('span[title]');
    const spanTitle = titleSpan?.getAttribute('title')?.trim();

    // 6. Check resource-card structural signal
    const isResourceCardClass =
      btn.className.includes('resource-card') ||
      Boolean(btn.closest('[class*="resource-card"]'));

    // 7. Verify filename plausibility
    const filenameFromSpan = spanTitle && isPlausibleFilename(spanTitle) ? spanTitle : undefined;
    const filenameFromAria = isPlausibleFilename(ariaLabel) ? ariaLabel : undefined;

    // Strongest match: span[title] equals aria-label or is substring
    const titlesMatch =
      Boolean(spanTitle) &&
      (spanTitle === ariaLabel || ariaLabel.includes(spanTitle!) || spanTitle!.includes(ariaLabel));

    if (!titlesMatch && !filenameFromAria && !filenameFromSpan) {
      continue;
    }

    const resolvedFilename = filenameFromSpan || filenameFromAria || ariaLabel;

    // 8. Verify user-side scope:
    // If userUnit is provided, verify relation:
    // - inside userUnit
    // - in sibling container of userUnit (or sibling of userUnit.parentElement)
    // - or inside turnRoot outside assistant
    if (userUnit) {
      const isInsideUserUnit = userUnit.contains(btn);
      const isSiblingOfUserUnit =
        userUnit.parentElement ? userUnit.parentElement.contains(btn) : false;
      const isUserSideOfTurn = !btn.closest(CHATGPT_SELECTORS.UNITS.ASSISTANT_FILTER);

      if (!isInsideUserUnit && !isSiblingOfUserUnit && !isUserSideOfTurn) {
        continue;
      }
    }

    visitedButtons.add(btn);
    const unitKey =
      userUnit?.getAttribute('data-content-search-unit-key') ||
      userUnit?.getAttribute('data-chatgpt-search-unit-key') ||
      btn.closest('[data-content-search-unit-key]')?.getAttribute('data-content-search-unit-key') ||
      undefined;

    cards.push({
      buttonEl: btn,
      filename: resolvedFilename,
      ariaLabel,
      spanTitle,
      turnKey,
      unitKey,
      isResourceCardClass,
    });
  }

  return cards;
}
