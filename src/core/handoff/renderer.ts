/**
 * Deterministic Markdown Transcript Renderer
 * Turns canonical ConversationSnapshot into clean, LLM-friendly Markdown.
 */

import {
  ConversationSnapshot,
  Message,
  ContentPart,
  StoredBlob,
} from '../model/canonical';
import { ensureChronologicalOrder } from '../model/validation';

/**
 * Handoff text names files by the names they are attached under, so the target model can match
 * "[Image: plan.png]" in the conversation to the attached plan.png.
 */
export interface AttachmentRefs {
  /** blob sha256 -> attachment file name. */
  names: Map<string, string>;
  /** Blobs sent along; named blobs outside this set are marked "not attached". Omitted: all of them. */
  attached?: Set<string>;
}

export interface RenderOptions {
  includeMetadataHeader?: boolean;
  blobMap?: Map<string, StoredBlob>;
  /** Refer to files by attachment name instead of blobs/<sha256> links. */
  attachmentRefs?: AttachmentRefs;
}

/** One line, no brackets: safe inside "[Image: ...]". */
function inlineLabel(text: string | undefined, max = 160): string {
  const clean = (text || '').replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function isAttachedRef(sha: string, refs: AttachmentRefs): boolean {
  return refs.names.has(sha) && (!refs.attached || refs.attached.has(sha));
}

function renderImageRef(part: Extract<ContentPart, { type: 'image' }>, refs: AttachmentRefs): string {
  const name = refs.names.get(part.blobSha256);
  const alt = inlineLabel(part.altText);
  if (!name) return `[Image not included${alt ? `: ${alt}` : ''}]`;
  const lowerAlt = alt.toLowerCase();
  const lowerName = name.toLowerCase();
  const altAddsInfo = alt && lowerAlt !== lowerName && lowerName.replace(/\.[^.]+$/, '') !== lowerAlt;
  const label = altAddsInfo ? `${name} (${alt})` : name;
  return isAttachedRef(part.blobSha256, refs) ? `[Image: ${label}]` : `[Image not attached: ${label}]`;
}

function renderFileRef(
  part: Extract<ContentPart, { type: 'file' }>,
  blob: StoredBlob | undefined,
  refs: AttachmentRefs
): string {
  const bytes = blob?.metadata.byteSize ?? part.byteSize;
  const size = bytes ? ` (${formatBytes(bytes)})` : '';
  const name = refs.names.get(part.blobSha256);
  if (!name) return `[File not included: ${inlineLabel(part.filename) || 'file'}${size}]`;
  return isAttachedRef(part.blobSha256, refs) ? `[File: ${name}${size}]` : `[File not attached: ${name}${size}]`;
}

/**
 * Formats a ContentPart into standard Markdown.
 */
export function renderContentPart(
  part: ContentPart,
  blobMap?: Map<string, StoredBlob>,
  refs?: AttachmentRefs
): string {
  switch (part.type) {
    case 'text':
      return part.text;

    case 'markdown':
      return part.markdown;

    case 'code': {
      const lang = part.language?.trim() || '';
      const titleLine = part.title ? `// ${part.title}\n` : '';
      return `\`\`\`${lang}\n${titleLine}${part.code}\n\`\`\``;
    }

    case 'image': {
      if (refs) return renderImageRef(part, refs);
      const blob = blobMap?.get(part.blobSha256);
      const name = part.altText || blob?.metadata.filename || `image-${part.blobSha256.slice(0, 8)}`;
      return `![${name}](blobs/${part.blobSha256})`;
    }

    case 'file': {
      const blob = blobMap?.get(part.blobSha256);
      if (refs) return renderFileRef(part, blob, refs);
      const sizeStr = blob ? ` (${formatBytes(blob.metadata.byteSize)})` : '';
      return `[Attachment: ${part.filename}${sizeStr}](blobs/${part.blobSha256})`;
    }

    case 'link':
      return `[${part.title || part.url}](${part.url})`;

    case 'citation': {
      if (part.url) {
        return ` [^${part.text}]( ${part.url} )`;
      }
      return ` [^${part.text}]`;
    }

    case 'table': {
      return renderMarkdownTable(part.headers, part.rows, part.caption);
    }

    case 'tool-result': {
      const toolName = part.toolName || 'Tool Execution';
      const outputText = stringifyToolOutput(part.output);
      return `> **${toolName}:**\n>\`\`\`\n${outputText.split('\n').map(l => `> ${l}`).join('\n')}\n>\`\`\``;
    }

    case 'unknown':
      if (part.rawText) {
        return part.rawText;
      }
      return `[Platform-specific element: ${part.platformType || 'unspecified'}]`;

    default:
      return '';
  }
}

/**
 * Renders a standard GitHub-flavored Markdown table.
 */
export function renderMarkdownTable(headers: string[], rows: string[][], caption?: string): string {
  if (headers.length === 0 && rows.length === 0) {
    return '';
  }

  const effectiveHeaders = headers.length > 0 ? headers : rows[0]?.map((_, i) => `Col ${i + 1}`) || [];
  const colCount = effectiveHeaders.length;

  const lines: string[] = [];
  if (caption) {
    lines.push(`*Table: ${caption}*`);
  }

  lines.push(`| ${effectiveHeaders.map(cleanTableCell).join(' | ')} |`);
  lines.push(`| ${effectiveHeaders.map(() => '---').join(' | ')} |`);

  for (const row of rows) {
    // Imported archives are only shape-checked; tolerate non-array rows and non-string cells.
    const padded = Array.isArray(row) ? row.map((c) => String(c ?? '')) : [String(row ?? '')];
    while (padded.length < colCount) {
      padded.push('');
    }
    lines.push(`| ${padded.slice(0, colCount).map(cleanTableCell).join(' | ')} |`);
  }

  return lines.join('\n');
}

function cleanTableCell(cell: unknown): string {
  return String(cell ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** JSON.stringify returns undefined for undefined and throws on BigInt (cborg decodes big ints). */
function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    const json = JSON.stringify(output, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
    return json ?? String(output);
  } catch {
    return String(output);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Formats a role name for the markdown header.
 */
function formatRole(role: Message['role']): string {
  switch (role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return 'Message';
  }
}

/**
 * Renders a single message to Markdown.
 */
export function renderMessage(
  message: Message,
  blobMap?: Map<string, StoredBlob>,
  refs?: AttachmentRefs
): string {
  const roleName = formatRole(message.role);
  const timeStr = message.createdAt ? ` (${message.createdAt})` : '';
  const header = `## Message ${message.sequence} — ${roleName}${timeStr}`;

  const renderedParts = message.content
    .map(p => renderContentPart(p, blobMap, refs))
    .filter(Boolean)
    .join('\n\n');

  return `${header}\n\n${renderedParts || '*(Empty message)*'}`;
}

/**
 * Renders an entire ConversationSnapshot into a deterministic Markdown transcript.
 */
export function renderTranscript(
  snapshot: ConversationSnapshot,
  options: RenderOptions = {}
): string {
  const sorted = ensureChronologicalOrder(snapshot);
  const sections: string[] = [];

  if (options.includeMetadataHeader !== false) {
    const metaLines: string[] = [
      '# Conversation',
      '',
      `Source: ${sorted.sourcePlatform}`,
      `Title: ${sorted.title || 'Untitled Conversation'}`,
      `Captured: ${sorted.capturedAt}`,
    ];

    if (sorted.sourceUrl) {
      metaLines.push(`Source URL: ${sorted.sourceUrl}`);
    }
    if (sorted.attachments.length > 0) {
      metaLines.push(`Attachments: ${sorted.attachments.length}`);
    }

    metaLines.push('');
    metaLines.push('---');
    sections.push(metaLines.join('\n'));
  }

  for (const msg of sorted.messages) {
    sections.push(renderMessage(msg, options.blobMap, options.attachmentRefs));
  }

  return sections.join('\n\n') + '\n';
}
