/**
 * Claude conversations through claude.ai's own conversation API, the one its web app reads.
 *
 * One request returns the whole conversation: every message (Claude's replies and artifacts
 * included, no scrolling), the files uploaded with each message and the text of pasted or
 * extracted documents. Requests are same-origin with the user's session (credentials:
 * 'include'); the session cookie is httpOnly and never seen. Nothing is stored or sent
 * anywhere else. The API is undocumented, so every field is treated as optional, and the
 * adapter falls back to reading the page when this fails.
 *
 * Endpoints (as used by claude.ai and by open-source exporters in 2026):
 *   GET /api/organizations
 *   GET /api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true
 *   GET /api/organizations/{org}/files/{file_uuid}/contents   (any type; /preview and /thumbnail
 *       under /api/{org}/files/{file_uuid}/ only render images and PDFs)
 */

import { CaptureIncompleteError } from '../../core/errors/errors';
import type { BlobStore } from '../../core/hashing/sha256';
import {
  baseMime,
  fileExtension,
  isImageMime,
  mimeForFilename,
  sniffImageMime,
  withImageExtension,
} from '../../core/model/attachments';
import type { ContentPart, Message, MessageRole, UnknownContentPart } from '../../core/model/canonical';
import { MEDIA_MAX_BYTES } from '../../utils/media-fetch';
import { ownBytes } from '../../utils/wire-bytes';
import type { CaptureProgress } from '../adapter';

/** Claude's stand-in for blocks the web app cannot render. */
const PLACEHOLDER = 'This block is not supported on your current device yet.';

interface ApiContentBlock {
  type?: string;
  text?: string | null;
  name?: string | null;
  input?: unknown;
}

interface ApiAttachment {
  file_name?: string | null;
  file_type?: string | null;
  extracted_content?: string | null;
}

interface ApiAsset {
  url?: string | null;
}

interface ApiFile {
  file_uuid?: string | null;
  uuid?: string | null;
  file_name?: string | null;
  file_kind?: string | null;
  preview_url?: string | null;
  thumbnail_url?: string | null;
  preview_asset?: ApiAsset | null;
  thumbnail_asset?: ApiAsset | null;
  document_asset?: ApiAsset | null;
}

interface ApiMessage {
  uuid?: string | null;
  parent_message_uuid?: string | null;
  sender?: string | null;
  text?: string | null;
  content?: ApiContentBlock[] | null;
  created_at?: string | null;
  attachments?: ApiAttachment[] | null;
  files?: ApiFile[] | null;
  files_v2?: ApiFile[] | null;
}

interface ApiConversation {
  name?: string | null;
  chat_messages?: ApiMessage[] | null;
  current_leaf_message_uuid?: string | null;
}

export interface ClaudeApiCaptureOptions {
  includeAttachments: boolean;
  /** The user chose to copy anyway: unreadable files become "not included" markers. */
  allowMissingFiles: boolean;
}

export interface ClaudeApiResult {
  title?: string;
  messages: Message[];
  conversationId: string;
}

/** The API could not be used (not signed in, other layout, network): read the page instead. */
export class ClaudeApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeApiUnavailableError';
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function claudeConversationId(pathname: string): string | null {
  const m = pathname.match(new RegExp(`/chat/(${UUID.source})`, 'i'));
  return m?.[1] ? m[1].toLowerCase() : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function getJson(origin: string, path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(origin + path, {
    credentials: 'include',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new ClaudeApiUnavailableError(`${path.split('?')[0]} answered ${res.status}`);
  return res.json();
}

/** Same-origin bytes, or null. HTML answers are sign-in or error pages, not files. */
async function getBytes(
  origin: string,
  path: string,
  expectHtml: boolean,
  signal?: AbortSignal
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  try {
    const res = await fetch(url.href, { credentials: 'include', cache: 'no-store', signal });
    if (!res.ok) return null;
    const type = baseMime(res.headers.get('content-type') || '');
    if (type === 'text/html' && !expectHtml) return null;
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MEDIA_MAX_BYTES) return null;
    // In Firefox MV3 content scripts the response buffer belongs to the page realm.
    return { data: ownBytes(buf), mimeType: type };
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** Organizations to try: the last active one (cookie) first, then every chat organization. */
async function organizationIds(origin: string, doc: Document, signal?: AbortSignal): Promise<string[]> {
  const ids: string[] = [];
  let cookie = '';
  try {
    cookie = doc.cookie || '';
  } catch {
    cookie = '';
  }
  const fromCookie = cookie.match(new RegExp(`(?:^|;\\s*)lastActiveOrg=(${UUID.source})`, 'i'))?.[1];
  if (fromCookie) ids.push(fromCookie.toLowerCase());
  try {
    const orgs = await getJson(origin, '/api/organizations', signal);
    if (Array.isArray(orgs)) {
      for (const o of orgs as Array<{ uuid?: unknown; capabilities?: unknown }>) {
        const uuid = typeof o?.uuid === 'string' ? o.uuid.toLowerCase() : '';
        const caps = Array.isArray(o?.capabilities) ? (o.capabilities as unknown[]) : null;
        if (uuid && UUID.test(uuid) && !ids.includes(uuid) && (!caps || caps.includes('chat'))) ids.push(uuid);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // The cookie may still be enough.
  }
  return ids;
}

/** The branch the user sees: from the current leaf back to the root. */
function activeBranch(all: ApiMessage[], leaf: string | null | undefined): ApiMessage[] {
  if (!leaf) return all;
  const byId = new Map<string, ApiMessage>();
  for (const m of all) if (typeof m?.uuid === 'string') byId.set(m.uuid, m);
  const branch: ApiMessage[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = leaf;
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const m: ApiMessage = byId.get(cur)!;
    branch.push(m);
    cur = m.parent_message_uuid;
  }
  return branch.length > 0 ? branch.reverse() : all;
}

function cleanText(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== PLACEHOLDER)
    .join('\n')
    .replace(/```[^\n]*\n\s*```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ARTIFACT_LANGUAGE: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'application/vnd.ant.react': 'jsx',
  'application/vnd.ant.mermaid': 'mermaid',
};

/** Artifacts and created files as code blocks; other tool calls are not conversation text. */
function toolUsePart(block: ApiContentBlock): ContentPart | null {
  const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : null;
  if (!input) return null;
  const code = typeof input.content === 'string' ? input.content : typeof input.file_text === 'string' ? input.file_text : null;
  if (!code || !code.trim()) return null;
  const path = str(input.path);
  const title = str(input.title) || path || str(block.name);
  const language =
    str(input.language)?.toLowerCase() ||
    ARTIFACT_LANGUAGE[str(input.type) || ''] ||
    fileExtension(path) ||
    undefined;
  return { type: 'code', code, language, title };
}

function marker(kind: 'image' | 'file', name: string, why: string, reason: 'excluded_by_user' | 'not_captured'): UnknownContentPart {
  return {
    type: 'unknown',
    platformType: `${reason === 'excluded_by_user' ? 'omitted' : 'uncaptured'}-${kind}`,
    rawText: `[${kind === 'image' ? 'Image' : 'File'} not included: ${name} (${why})]`,
    metadata: { reason, originalType: kind, filename: name },
  };
}

function isTextName(name: string): boolean {
  const mime = mimeForFilename(name);
  return !!mime && (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml');
}

interface FileJob {
  origin: string;
  org: string;
  blobStore: BlobStore;
  signal?: AbortSignal;
}

async function filePart(file: ApiFile, job: FileJob): Promise<ContentPart | null> {
  const uuid = str(file.file_uuid) || str(file.uuid);
  const kind = str(file.file_kind);
  const name = str(file.file_name) || (kind === 'image' ? 'image' : 'file');
  const candidates = [
    uuid && `/api/organizations/${job.org}/files/${uuid}/contents`,
    str(file.preview_url),
    str(file.preview_asset?.url),
    str(file.document_asset?.url),
    uuid && `/api/${job.org}/files/${uuid}/preview`,
    str(file.thumbnail_url),
    str(file.thumbnail_asset?.url),
    uuid && `/api/${job.org}/files/${uuid}/thumbnail`,
  ].filter((c): c is string => !!c);

  const expectHtml = /\.html?$/i.test(name);
  let got: { data: Uint8Array; mimeType: string } | null = null;
  for (const c of [...new Set(candidates)]) {
    got = await getBytes(job.origin, c, expectHtml, job.signal);
    if (got) break;
  }
  if (!got) return null;

  const sniffed = sniffImageMime(got.data);
  const served = got.mimeType && got.mimeType !== 'application/octet-stream' ? got.mimeType : undefined;
  const mimeType = sniffed || served || mimeForFilename(name) || 'application/octet-stream';
  const image = kind === 'image' || isImageMime(mimeType);
  const filename = image ? withImageExtension(name, mimeType) : name;
  const meta = await job.blobStore.put(got.data, {
    mimeType,
    filename,
    role: 'user-upload',
    captureSource: 'claude-api',
  });
  return image
    ? { type: 'image', blobSha256: meta.sha256, altText: name, mimeType }
    : { type: 'file', blobSha256: meta.sha256, filename, mimeType, byteSize: meta.byteSize };
}

/** Pasted text and extracted document text, as a text file under the attachment's name. */
async function attachmentPart(att: ApiAttachment, blobStore: BlobStore): Promise<ContentPart | null> {
  const text = typeof att.extracted_content === 'string' ? att.extracted_content : '';
  if (!text) return null;
  const name = str(att.file_name) || 'pasted-text.txt';
  // "report.docx" here is Claude's text extraction of it, so it is saved as text.
  const filename = isTextName(name) ? name : `${name}.txt`;
  const mimeType = mimeForFilename(filename) || 'text/plain';
  const data = new TextEncoder().encode(text);
  const meta = await blobStore.put(data, { mimeType, filename, role: 'user-upload', captureSource: 'claude-api' });
  return { type: 'file', blobSha256: meta.sha256, filename, mimeType, byteSize: meta.byteSize };
}

export async function captureClaudeViaApi(
  doc: Document,
  blobStore: BlobStore,
  opts: ClaudeApiCaptureOptions,
  onProgress?: (progress: CaptureProgress) => void,
  signal?: AbortSignal
): Promise<ClaudeApiResult> {
  const loc = doc.defaultView?.location ?? (typeof location !== 'undefined' ? location : undefined);
  if (!loc || !/^https:$/i.test(loc.protocol)) throw new ClaudeApiUnavailableError('not a claude.ai page');
  const origin = loc.origin;
  const conversationId = claudeConversationId(loc.pathname);
  if (!conversationId) throw new ClaudeApiUnavailableError('no conversation id in the address');

  onProgress?.({
    phase: 'crawling',
    messagesFound: 0,
    imagesFound: 0,
    filesFound: 0,
    currentOperation: 'Reading the Claude conversation...',
  });

  let data: ApiConversation | null = null;
  let org = '';
  let lastError: unknown = new ClaudeApiUnavailableError('no organization');
  for (const id of await organizationIds(origin, doc, signal)) {
    try {
      const body = await getJson(
        origin,
        `/api/organizations/${id}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
        signal
      );
      if (body && typeof body === 'object' && Array.isArray((body as ApiConversation).chat_messages)) {
        data = body as ApiConversation;
        org = id;
        break;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  if (!data) throw lastError instanceof Error ? lastError : new ClaudeApiUnavailableError(String(lastError));

  const branch = activeBranch(data.chat_messages ?? [], data.current_leaf_message_uuid);
  const job: FileJob = { origin, org, blobStore, signal };
  const messages: Message[] = [];
  const missing: string[] = [];
  let images = 0;
  let files = 0;

  for (const m of branch) {
    if (signal?.aborted) throw new CaptureIncompleteError('Capture cancelled by user.', { terminationReason: 'aborted' });
    const role: MessageRole | null = m?.sender === 'human' ? 'user' : m?.sender === 'assistant' ? 'assistant' : null;
    if (!role) continue;
    const content: ContentPart[] = [];

    // Files first: claude.ai shows them above the message.
    const seenFiles = new Set<string>();
    const fileList = [...(m.files_v2 ?? []), ...(m.files ?? [])].filter((f) => {
      const key = str(f?.file_uuid) || str(f?.uuid) || str(f?.file_name) || '';
      if (!key || seenFiles.has(key)) return false;
      seenFiles.add(key);
      return true;
    });
    const fileNames = new Set<string>();
    for (const f of fileList) {
      const name = str(f.file_name) || (f.file_kind === 'image' ? 'image' : 'file');
      const kind = f.file_kind === 'image' ? 'image' : 'file';
      fileNames.add(name.toLowerCase());
      if (!opts.includeAttachments) {
        content.push(marker(kind, name, 'attachments were excluded from this export', 'excluded_by_user'));
        continue;
      }
      const part = await filePart(f, job);
      if (part) {
        content.push(part);
        if (part.type === 'image') images++;
        else files++;
      } else if (opts.allowMissingFiles) {
        content.push(marker(kind, name, 'its bytes could not be captured', 'not_captured'));
      } else {
        missing.push(name);
      }
    }
    for (const att of m.attachments ?? []) {
      const name = str(att?.file_name) || 'pasted-text.txt';
      if (fileNames.has(name.toLowerCase())) continue;
      if (!opts.includeAttachments) {
        content.push(marker('file', name, 'attachments were excluded from this export', 'excluded_by_user'));
        continue;
      }
      const part = await attachmentPart(att, blobStore);
      if (part) {
        content.push(part);
        files++;
      }
    }

    // Message text, artifacts and created files, in order. Thinking and tool results are not
    // user-visible conversation.
    const blocks = Array.isArray(m.content) ? m.content : [];
    let hadText = false;
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const text = cleanText(block.text);
        if (text) {
          content.push(role === 'assistant' ? { type: 'markdown', markdown: text } : { type: 'text', text });
          hadText = true;
        }
      } else if (block?.type === 'tool_use') {
        const part = toolUsePart(block);
        if (part) content.push(part);
      }
    }
    if (!hadText && typeof m.text === 'string') {
      const text = cleanText(m.text);
      if (text) content.push(role === 'assistant' ? { type: 'markdown', markdown: text } : { type: 'text', text });
    }

    if (content.length === 0) continue;
    messages.push({
      id: `claude-${str(m.uuid) || `api-${messages.length + 1}`}`,
      role,
      sequence: messages.length + 1,
      createdAt: str(m.created_at),
      content,
    });
    onProgress?.({
      phase: 'resolving-media',
      messagesFound: messages.length,
      imagesFound: images,
      filesFound: files,
      currentOperation: `Reading Claude messages (${messages.length} of ${branch.length})...`,
    });
  }

  if (missing.length > 0) {
    throw new CaptureIncompleteError(`Failed to capture user upload file bytes for ${missing.join(', ')}`, {
      terminationReason: 'unresolved_user_attachment',
      filename: missing[0],
      missingFiles: missing,
    });
  }

  return { title: str(data.name), messages, conversationId };
}
