import { describe, it, expect } from 'vitest';
import {
  ConversationSnapshot,
  CANONICAL_SCHEMA_VERSION,
} from '../../src/core/model/canonical';
import {
  validateConversationSnapshot,
  ensureChronologicalOrder,
} from '../../src/core/model/validation';
import {
  ArchiveCorruptError,
  UnsupportedArchiveVersionError,
} from '../../src/core/errors/errors';

describe('Canonical Conversation Model Validation', () => {
  const validSnapshot: ConversationSnapshot = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    id: 'snap-12345',
    sourcePlatform: 'chatgpt',
    title: 'Test Conversation',
    sourceUrl: 'https://chatgpt.com/c/12345',
    capturedAt: '2026-09-28T12:00:00Z',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        sequence: 1,
        content: [{ type: 'text', text: 'Hello, how are you?' }],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        sequence: 2,
        content: [{ type: 'markdown', markdown: 'I am doing well, thank you!' }],
      },
    ],
    attachments: [],
  };

  it('validates a correct snapshot without throwing', () => {
    expect(() => validateConversationSnapshot(validSnapshot)).not.toThrow();
  });

  it('rejects unsupported schema version', () => {
    const invalid = { ...validSnapshot, schemaVersion: 99 };
    expect(() => validateConversationSnapshot(invalid)).toThrow(UnsupportedArchiveVersionError);
  });

  it('rejects snapshot missing required fields', () => {
    const missingId = { ...validSnapshot, id: '' };
    expect(() => validateConversationSnapshot(missingId)).toThrow(ArchiveCorruptError);

    const missingPlatform = { ...validSnapshot, sourcePlatform: '' };
    expect(() => validateConversationSnapshot(missingPlatform)).toThrow(ArchiveCorruptError);
  });

  it('rejects duplicate message IDs', () => {
    const duplicateMsgs = {
      ...validSnapshot,
      messages: [
        {
          id: 'duplicate-id',
          role: 'user' as const,
          sequence: 1,
          content: [{ type: 'text' as const, text: 'First' }],
        },
        {
          id: 'duplicate-id',
          role: 'assistant' as const,
          sequence: 2,
          content: [{ type: 'text' as const, text: 'Second' }],
        },
      ],
    };
    expect(() => validateConversationSnapshot(duplicateMsgs)).toThrow(/Duplicate message id detected/);
  });

  it('rejects duplicate attachment hashes in manifest', () => {
    const duplicateBlobs = {
      ...validSnapshot,
      attachments: [
        {
          sha256: 'a'.repeat(64),
          mimeType: 'image/png',
          byteSize: 100,
        },
        {
          sha256: 'a'.repeat(64),
          mimeType: 'image/jpeg',
          byteSize: 200,
        },
      ],
    };
    expect(() => validateConversationSnapshot(duplicateBlobs)).toThrow(/Duplicate attachment sha256/);
  });

  it('sorts messages chronologically by sequence', () => {
    const unordered: ConversationSnapshot = {
      ...validSnapshot,
      messages: [
        {
          id: 'msg-3',
          role: 'assistant',
          sequence: 3,
          content: [{ type: 'text', text: 'Step 3' }],
        },
        {
          id: 'msg-1',
          role: 'user',
          sequence: 1,
          content: [{ type: 'text', text: 'Step 1' }],
        },
        {
          id: 'msg-2',
          role: 'assistant',
          sequence: 2,
          content: [{ type: 'text', text: 'Step 2' }],
        },
      ],
    };

    const ordered = ensureChronologicalOrder(unordered);
    expect(ordered.messages.map((m) => m.sequence)).toEqual([1, 2, 3]);
  });
});
