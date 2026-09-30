/**
 * Target importer for Google Gemini
 * Inserts the handoff prompt into Gemini's Quill editor (never the <rich-textarea> host itself).
 */

import { PreparedHandoff } from '../../core/handoff/strategies';
import { ImportResult } from '../adapter';
import { injectHandoffIntoComposer } from '../composer-import';
import { GEMINI_SELECTORS } from './selectors';

export async function injectGeminiImport(
  handoff: PreparedHandoff,
  doc: Document = document
): Promise<ImportResult> {
  return injectHandoffIntoComposer(handoff, doc, {
    platform: 'gemini',
    displayName: 'Gemini',
    composerSelectors: [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea',
    ],
    fileInputSelectors: [GEMINI_SELECTORS.COMPOSER.FILE_INPUT],
  });
}
