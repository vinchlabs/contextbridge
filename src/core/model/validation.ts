/**
 * Validation and sanity checking for the Canonical Conversation Model
 */

import {
  ConversationSnapshot,
  Message,
  ContentPart,
  CANONICAL_SCHEMA_VERSION,
} from './canonical';
import {
  ArchiveCorruptError,
  UnsupportedArchiveVersionError,
  SecurityBoundsExceededError,
} from '../errors/errors';

export const BOUNDS = {
  MAX_MESSAGES: 100_000,
  MAX_ATTACHMENTS: 10_000,
  MAX_PARTS_PER_MESSAGE: 1_000,
  MAX_TEXT_PART_LENGTH: 50 * 1024 * 1024, // 50 MB
  MAX_BLOB_SIZE: 2 * 1024 * 1024 * 1024, // 2 GB
  MAX_TITLE_LENGTH: 2048,
  MAX_ID_LENGTH: 512,
} as const;

export function validateConversationSnapshot(data: unknown): asserts data is ConversationSnapshot {
  if (typeof data !== 'object' || data === null) {
    throw new ArchiveCorruptError('Snapshot must be an object');
  }

  const record = data as Record<string, unknown>;

  if (typeof record.schemaVersion !== 'number') {
    throw new ArchiveCorruptError('Missing or non-numeric schemaVersion');
  }

  if (record.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    throw new UnsupportedArchiveVersionError(record.schemaVersion, CANONICAL_SCHEMA_VERSION);
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new ArchiveCorruptError('Invalid or missing snapshot id');
  }
  if (record.id.length > BOUNDS.MAX_ID_LENGTH) {
    throw new SecurityBoundsExceededError('snapshot id length', BOUNDS.MAX_ID_LENGTH, record.id.length);
  }

  if (typeof record.sourcePlatform !== 'string' || record.sourcePlatform.length === 0) {
    throw new ArchiveCorruptError('Invalid or missing sourcePlatform');
  }

  if (typeof record.capturedAt !== 'string') {
    throw new ArchiveCorruptError('Missing capturedAt timestamp');
  }

  if (record.title !== undefined) {
    if (typeof record.title !== 'string') {
      throw new ArchiveCorruptError('Snapshot title must be a string');
    }
    if (record.title.length > BOUNDS.MAX_TITLE_LENGTH) {
      throw new SecurityBoundsExceededError('title length', BOUNDS.MAX_TITLE_LENGTH, record.title.length);
    }
  }

  if (!Array.isArray(record.messages)) {
    throw new ArchiveCorruptError('messages must be an array');
  }
  if (record.messages.length > BOUNDS.MAX_MESSAGES) {
    throw new SecurityBoundsExceededError('messages count', BOUNDS.MAX_MESSAGES, record.messages.length);
  }

  if (!Array.isArray(record.attachments)) {
    throw new ArchiveCorruptError('attachments must be an array');
  }
  if (record.attachments.length > BOUNDS.MAX_ATTACHMENTS) {
    throw new SecurityBoundsExceededError('attachments count', BOUNDS.MAX_ATTACHMENTS, record.attachments.length);
  }

  const seenMessageIds = new Set<string>();
  for (let i = 0; i < record.messages.length; i++) {
    const msg = record.messages[i];
    validateMessage(msg, i);
    if (seenMessageIds.has(msg.id)) {
      throw new ArchiveCorruptError(`Duplicate message id detected: ${msg.id}`);
    }
    seenMessageIds.add(msg.id);
  }

  const seenBlobHashes = new Set<string>();
  for (let i = 0; i < record.attachments.length; i++) {
    const att = record.attachments[i];
    if (typeof att !== 'object' || att === null) {
      throw new ArchiveCorruptError(`Invalid attachment item at index ${i}`);
    }
    const attRec = att as Record<string, unknown>;
    if (typeof attRec.sha256 !== 'string' || attRec.sha256.length !== 64) {
      throw new ArchiveCorruptError(`Invalid attachment sha256 at index ${i}`);
    }
    if (typeof attRec.mimeType !== 'string') {
      throw new ArchiveCorruptError(`Invalid attachment mimeType at index ${i}`);
    }
    if (typeof attRec.byteSize !== 'number' || attRec.byteSize < 0) {
      throw new ArchiveCorruptError(`Invalid attachment byteSize at index ${i}`);
    }
    if (attRec.byteSize > BOUNDS.MAX_BLOB_SIZE) {
      throw new SecurityBoundsExceededError('blob size', BOUNDS.MAX_BLOB_SIZE, attRec.byteSize);
    }
    if (seenBlobHashes.has(attRec.sha256)) {
      throw new ArchiveCorruptError(`Duplicate attachment sha256 in manifest: ${attRec.sha256}`);
    }
    seenBlobHashes.add(attRec.sha256);
  }
}

export function validateMessage(msg: unknown, index: number): asserts msg is Message {
  if (typeof msg !== 'object' || msg === null) {
    throw new ArchiveCorruptError(`Message at index ${index} must be an object`);
  }

  const m = msg as Record<string, unknown>;

  if (typeof m.id !== 'string' || m.id.length === 0) {
    throw new ArchiveCorruptError(`Message at index ${index} has missing or invalid id`);
  }
  if (m.id.length > BOUNDS.MAX_ID_LENGTH) {
    throw new SecurityBoundsExceededError('message id length', BOUNDS.MAX_ID_LENGTH, m.id.length);
  }

  const validRoles = ['user', 'assistant', 'system', 'tool'];
  if (typeof m.role !== 'string' || !validRoles.includes(m.role)) {
    throw new ArchiveCorruptError(`Message ${m.id} has invalid role: ${String(m.role)}`);
  }

  if (typeof m.sequence !== 'number' || Number.isNaN(m.sequence)) {
    throw new ArchiveCorruptError(`Message ${m.id} has invalid sequence number`);
  }

  if (!Array.isArray(m.content)) {
    throw new ArchiveCorruptError(`Message ${m.id} content must be an array`);
  }
  if (m.content.length > BOUNDS.MAX_PARTS_PER_MESSAGE) {
    throw new SecurityBoundsExceededError(
      `content parts for message ${m.id}`,
      BOUNDS.MAX_PARTS_PER_MESSAGE,
      m.content.length
    );
  }

  for (let j = 0; j < m.content.length; j++) {
    validateContentPart(m.content[j], m.id, j);
  }
}

export function validateContentPart(part: unknown, messageId: string, partIndex: number): asserts part is ContentPart {
  if (typeof part !== 'object' || part === null) {
    throw new ArchiveCorruptError(`Content part ${partIndex} in message ${messageId} must be an object`);
  }

  const p = part as Record<string, unknown>;
  if (typeof p.type !== 'string') {
    throw new ArchiveCorruptError(`Content part ${partIndex} in message ${messageId} missing type`);
  }

  switch (p.type) {
    case 'text':
      if (typeof p.text !== 'string') {
        throw new ArchiveCorruptError(`Text part in message ${messageId} must have string text`);
      }
      if (p.text.length > BOUNDS.MAX_TEXT_PART_LENGTH) {
        throw new SecurityBoundsExceededError(`text part length in ${messageId}`, BOUNDS.MAX_TEXT_PART_LENGTH, p.text.length);
      }
      break;

    case 'markdown':
      if (typeof p.markdown !== 'string') {
        throw new ArchiveCorruptError(`Markdown part in message ${messageId} must have string markdown`);
      }
      if (p.markdown.length > BOUNDS.MAX_TEXT_PART_LENGTH) {
        throw new SecurityBoundsExceededError(`markdown part length in ${messageId}`, BOUNDS.MAX_TEXT_PART_LENGTH, p.markdown.length);
      }
      break;

    case 'code':
      if (typeof p.code !== 'string') {
        throw new ArchiveCorruptError(`Code part in message ${messageId} must have string code`);
      }
      if (p.code.length > BOUNDS.MAX_TEXT_PART_LENGTH) {
        throw new SecurityBoundsExceededError(`code part length in ${messageId}`, BOUNDS.MAX_TEXT_PART_LENGTH, p.code.length);
      }
      break;

    case 'image':
      if (typeof p.blobSha256 !== 'string' || p.blobSha256.length !== 64) {
        throw new ArchiveCorruptError(`Image part in message ${messageId} must have 64-char hex blobSha256`);
      }
      break;

    case 'file':
      if (typeof p.blobSha256 !== 'string' || p.blobSha256.length !== 64) {
        throw new ArchiveCorruptError(`File part in message ${messageId} must have 64-char hex blobSha256`);
      }
      if (typeof p.filename !== 'string') {
        throw new ArchiveCorruptError(`File part in message ${messageId} must have string filename`);
      }
      break;

    case 'link':
      if (typeof p.url !== 'string') {
        throw new ArchiveCorruptError(`Link part in message ${messageId} must have string url`);
      }
      break;

    case 'citation':
      if (typeof p.text !== 'string') {
        throw new ArchiveCorruptError(`Citation part in message ${messageId} must have string text`);
      }
      break;

    case 'table':
      if (!Array.isArray(p.headers) || !Array.isArray(p.rows)) {
        throw new ArchiveCorruptError(`Table part in message ${messageId} must have array headers and rows`);
      }
      break;

    case 'tool-result':
      if (!('output' in p)) {
        throw new ArchiveCorruptError(`Tool result in message ${messageId} must have output`);
      }
      break;

    case 'unknown':
      // Accept unknown parts gracefully for forward compatibility
      break;

    default:
      // Unknown types are preserved as-is for forward compatibility
      break;
  }
}

/**
 * Ensures messages in snapshot are sorted chronologically by sequence
 */
export function ensureChronologicalOrder(snapshot: ConversationSnapshot): ConversationSnapshot {
  const sortedMessages = [...snapshot.messages].sort((a, b) => a.sequence - b.sequence);
  return {
    ...snapshot,
    messages: sortedMessages,
  };
}
