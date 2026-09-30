/**
 * Target importer for ChatGPT
 * Inserts the handoff prompt into ChatGPT's ProseMirror composer and hands files to its uploader.
 */

import { PreparedHandoff } from '../../core/handoff/strategies';
import { ImportResult } from '../adapter';
import { injectHandoffIntoComposer } from '../composer-import';
import { CHATGPT_SELECTORS } from './selectors';

export async function injectChatGPTImport(
  handoff: PreparedHandoff,
  doc: Document = document
): Promise<ImportResult> {
  return injectHandoffIntoComposer(handoff, doc, {
    platform: 'chatgpt',
    displayName: 'ChatGPT',
    composerSelectors: [
      'div#prompt-textarea[contenteditable="true"]',
      CHATGPT_SELECTORS.COMPOSER.TEXTAREA,
      'textarea[placeholder*="Message"]',
      'form div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
    fileInputSelectors: [CHATGPT_SELECTORS.COMPOSER.FILE_INPUT, 'input[type="file"]'],
  });
}
