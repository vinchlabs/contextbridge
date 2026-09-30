/**
 * Plain-language lines about what happened to the files of a handoff, shared by the in-page
 * notice and the popup. Only groups that have files get a line.
 */

export interface AttachReportInput {
  attachedFiles?: string[];
  filesNotConfirmed?: string[];
  filesUnverified?: string[];
  filesOverLimit?: string[];
  fileLimit?: number;
  manualAttachmentRequiredFiles?: string[];
}

/** Facts from the prepared handoff (not known to the stored result). */
export interface AttachReportExtras {
  fileLimit?: number;
  unsupportedFiles?: string[];
  archiveFiles?: string[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function listNames(names: string[], max = 4): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** Where the user gets copies of the files to attach by hand. */
export function copiesHint(manual: string[]): string {
  const transcript = manual.includes('transcript.md');
  const others = manual.some((n) => n !== 'transcript.md');
  if (transcript && others) return 'Save .md (the transcript) and Save files in the ContextBridge menu give you copies.';
  if (transcript) return 'Save .md in the ContextBridge menu gives you a copy of the transcript.';
  return 'Save files in the ContextBridge menu gives you copies.';
}

export function describeFiles(
  result: AttachReportInput,
  target: string,
  extras: AttachReportExtras = {},
  maxNames = 4
): string[] {
  const lines: string[] = [];
  const attached = result.attachedFiles ?? [];
  const notConfirmed = result.filesNotConfirmed ?? [];
  const unverified = result.filesUnverified ?? [];
  const overLimit = result.filesOverLimit ?? [];
  const manual = result.manualAttachmentRequiredFiles ?? [];
  // Results without the breakdown (older content scripts): everything manual is "attach yourself".
  const otherManual = manual.filter((n) => !notConfirmed.includes(n) && !unverified.includes(n) && !overLimit.includes(n));

  if (attached.length > 0) {
    lines.push(`Attached in ${target}: ${listNames(attached, maxNames)}.`);
  }
  if (notConfirmed.length > 0) {
    lines.push(
      `ContextBridge could not confirm these files in ${target}: ${listNames(notConfirmed, maxNames)}. ` +
        'If they are missing, attach them yourself.'
    );
  }
  if (unverified.length > 0) {
    lines.push(
      `${target} reacted to the files, but ContextBridge could not see them on the page: ${listNames(unverified, maxNames)}. ` +
        'Check the message box before you send and attach any that are missing.'
    );
  }
  if (overLimit.length > 0) {
    const limit = result.fileLimit ?? extras.fileLimit;
    lines.push(
      `${target} takes up to ${limit ? plural(limit, 'file') : 'a limited number of files'} per message. ` +
        `Send these in your next message: ${listNames(overLimit, maxNames)}.`
    );
  }
  if (otherManual.length > 0) {
    lines.push(`Attach these yourself: ${listNames(otherManual, maxNames)}.`);
  }
  const unsupported = extras.unsupportedFiles ?? [];
  if (unsupported.length > 0) {
    lines.push(`Not attached, ${target} does not take these file types: ${listNames(unsupported, maxNames)}.`);
  }
  const archives = extras.archiveFiles ?? [];
  if (archives.length > 0) {
    lines.push(`Not attached: ${plural(archives.length, '.ctxbridge file')}. ContextBridge archives are never uploaded.`);
  }
  if (manual.length > 0 || unsupported.length > 0) lines.push(copiesHint([...manual, ...unsupported]));
  return lines;
}
