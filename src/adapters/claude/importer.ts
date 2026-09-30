/**
 * Target importer for Claude
 * Inserts the handoff prompt into Claude's ProseMirror composer and hands files to its uploader.
 */

import { PreparedHandoff } from '../../core/handoff/strategies';
import { ImportResult } from '../adapter';
import { injectHandoffIntoComposer } from '../composer-import';
import { CLAUDE_SELECTORS } from './selectors';

export async function injectClaudeImport(
  handoff: PreparedHandoff,
  doc: Document = document
): Promise<ImportResult> {
  return injectHandoffIntoComposer(handoff, doc, {
    platform: 'claude',
    displayName: 'Claude',
    // Priority order: the real ProseMirror composer first, generic contenteditable last.
    composerSelectors: [
      'fieldset div.ProseMirror[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'fieldset div[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ],
    fileInputSelectors: [CLAUDE_SELECTORS.COMPOSER.FILE_INPUT],
  });
}
