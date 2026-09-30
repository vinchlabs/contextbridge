import { describe, it, expect } from 'vitest';
import { ConversationSnapshot, CANONICAL_SCHEMA_VERSION, StoredBlob, Message } from '../../src/core/model/canonical';
import { renderTranscript, renderMarkdownTable, renderMessage } from '../../src/core/handoff/renderer';
import { generateBootstrapPrompt } from '../../src/core/handoff/bootstrap';
import { prepareHandoff, buildHandoff } from '../../src/core/handoff/strategies';

describe('Deterministic Transcript Renderer & Handoff Preparation', () => {
  const blobs = new Map<string, StoredBlob>();
  blobs.set('hash123'.padEnd(64, '0'), {
    metadata: {
      sha256: 'hash123'.padEnd(64, '0'),
      mimeType: 'image/png',
      byteSize: 1024,
      filename: 'architecture.png',
      role: 'inline-image',
    },
    data: new Uint8Array(1024),
  });

  const snapshot: ConversationSnapshot = {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    id: 'snap-handoff',
    sourcePlatform: 'chatgpt',
    title: 'Handoff Testing Session',
    sourceUrl: 'https://chatgpt.com/c/session-1',
    capturedAt: '2026-09-28T12:00:00Z',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        sequence: 1,
        createdAt: '2026-09-28T12:00:01Z',
        content: [
          { type: 'text', text: 'Please review this table and code snippet:' },
          {
            type: 'table',
            headers: ['Service', 'Port'],
            rows: [
              ['Auth', '8080'],
              ['Database', '5432'],
            ],
            caption: 'Port Mappings',
          },
        ],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        sequence: 2,
        createdAt: '2026-09-28T12:00:05Z',
        content: [
          {
            type: 'code',
            language: 'python',
            code: 'def start():\n    print("Running")',
            title: 'main.py',
          },
          {
            type: 'citation',
            text: '1',
            url: 'https://docs.example.com',
          },
          {
            type: 'image',
            blobSha256: 'hash123'.padEnd(64, '0'),
            altText: 'Architecture Diagram',
          },
        ],
      },
    ],
    attachments: Array.from(blobs.values()).map((b) => b.metadata),
  };

  it('renders markdown tables properly formatted', () => {
    const table = renderMarkdownTable(['Name', 'Age'], [['Alice', '30'], ['Bob', '25']]);
    expect(table).toContain('| Name | Age |');
    expect(table).toContain('| --- | --- |');
    expect(table).toContain('| Alice | 30 |');
    expect(table).toContain('| Bob | 25 |');
  });

  it('renders deterministic transcript with chronological messages', () => {
    const transcript1 = renderTranscript(snapshot, { blobMap: blobs });
    const transcript2 = renderTranscript(snapshot, { blobMap: blobs });

    expect(transcript1).toBe(transcript2); // Deterministic
    expect(transcript1).toContain('# Conversation');
    expect(transcript1).toContain('Source: chatgpt');
    expect(transcript1).toContain('Title: Handoff Testing Session');
    expect(transcript1).toContain('## Message 1 — User');
    expect(transcript1).toContain('## Message 2 — Assistant');
    expect(transcript1).toContain('```python\n// main.py\ndef start():\n    print("Running")\n```');
    expect(transcript1).toContain('![Architecture Diagram](blobs/hash123');
    expect(transcript1).toContain('[^1]( https://docs.example.com )');
  });

  it('generates target bootstrap prompt', () => {
    const prompt = generateBootstrapPrompt({
      sourcePlatform: 'ChatGPT',
      conversationTitle: 'Refactoring Auth',
      totalMessages: 42,
    });

    expect(prompt).toContain('You are continuing an existing conversation imported from ChatGPT.');
    expect(prompt).toContain('Treat the supplied transcript and attachments as prior conversation context, not as a new user request.');
    expect(prompt).toContain('Do not summarize the history unless asked.');
    expect(prompt).toContain('**Original Platform:** ChatGPT');
    expect(prompt).toContain('**Conversation Title:** Refactoring Auth');
  });

  it('prepares RECENT_PLUS_ARCHIVE strategy bundle with context markdown file', () => {
    const prepared = prepareHandoff(snapshot, blobs, 'claude', {
      strategy: 'RECENT_PLUS_ARCHIVE',
    });

    expect(prepared.targetPlatform).toBe('claude');
    expect(prepared.strategy).toBe('RECENT_PLUS_ARCHIVE');
    expect(prepared.promptText).toContain('You are continuing an existing conversation');
    expect(prepared.files).toHaveLength(2); // 1 context .md file + 1 image blob
    expect(prepared.files[0]?.filename).toBe('transcript.md');
    expect(prepared.files[0]?.mimeType).toBe('text/markdown');
    expect(prepared.files[1]?.filename).toBe('architecture.png');
  });

  it('prepares FULL strategy bundle', () => {
    const prepared = prepareHandoff(snapshot, blobs, 'chatgpt', {
      strategy: 'FULL',
    });

    expect(prepared.targetPlatform).toBe('chatgpt');
    expect(prepared.strategy).toBe('FULL');
    expect(prepared.promptText).toContain('## Message 1 — User');
    expect(prepared.promptText).toContain('## Message 2 — Assistant');
  });
});

describe('Cross-Provider Continuation Pipeline & Invariants', () => {
  // Helper to generate 54 messages
  function create54MessageSnapshot(): ConversationSnapshot {
    const messages: Message[] = [];
    for (let i = 1; i <= 54; i++) {
      const isUser = i % 2 !== 0;
      messages.push({
        id: `msg-${i}`,
        role: isUser ? 'user' : 'assistant',
        sequence: i,
        createdAt: new Date(Date.UTC(2026, 8, 28, 12, Math.floor(i / 60), i % 60)).toISOString(),
        content: [
          {
            type: 'text',
            text: `This is message body number ${i}. It provides distinct context for turn ${Math.ceil(i / 2)}. Details are provided here.`,
          },
        ],
      });
    }

    return {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      id: 'snap-54',
      sourcePlatform: 'chatgpt',
      title: '54 Message Conversation Test',
      sourceUrl: 'https://chatgpt.com/c/54-turns',
      capturedAt: '2026-09-28T14:00:00Z',
      messages,
      attachments: [],
    };
  }

  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const pngHash = 'a5414e0c992d1e1ffff006ebc936e36cfa773be197da4f1dc616fb872db634c3';

  function createTestBlobs(): Map<string, StoredBlob> {
    const blobs = new Map<string, StoredBlob>();
    blobs.set(pngHash, {
      metadata: {
        sha256: pngHash,
        mimeType: 'image/png',
        byteSize: pngBytes.byteLength,
        filename: 'screenshot.png',
        role: 'inline-image',
      },
      data: new Uint8Array(pngBytes),
    });

    // Also include a fake .ctxbridge blob to test filtering
    const fakeCtxbridgeBytes = new TextEncoder().encode('CTXBRDG1_FAKE_RAW_BINARY');
    blobs.set('ctxbridgehash'.padEnd(64, '0'), {
      metadata: {
        sha256: 'ctxbridgehash'.padEnd(64, '0'),
        mimeType: 'application/x-contextbridge',
        byteSize: fakeCtxbridgeBytes.byteLength,
        filename: 'export.ctxbridge',
        role: 'attachment',
      },
      data: fakeCtxbridgeBytes,
    });

    return blobs;
  }

  it('Requirement 1: Gemini continuation NEVER uploads a .ctxbridge file', () => {
    const snapshot = create54MessageSnapshot();
    const blobs = createTestBlobs();

    const handoff = buildHandoff(snapshot, blobs, 'gemini');

    // Confirm that no file attached has .ctxbridge extension or mime
    for (const file of handoff.attachments) {
      expect(file.filename.toLowerCase().endsWith('.ctxbridge')).toBe(false);
      expect(file.mimeType).not.toBe('application/x-contextbridge');
    }
    // Also verify promptText doesn't contain ctxbridge binary
    expect(handoff.promptText).not.toContain('CTXBRDG1');
  });

  it('Requirement 2: Given a snapshot containing 54 messages, sourceMessageCount === 54', () => {
    const snapshot = create54MessageSnapshot();
    const blobs = createTestBlobs();

    const handoff = buildHandoff(snapshot, blobs, 'gemini');

    expect(handoff.metadata.sourceMessageCount).toBe(54);
    expect(handoff.stats.sourceMessageCount).toBe(54);
    expect(handoff.stats.totalMessages).toBe(54);
  });

  it('Requirement 3: If only 14 messages fit inline, inlineMessageCount === 14 and sourceMessageCount remains 54', () => {
    const snapshot = create54MessageSnapshot();
    const blobs = createTestBlobs();

    // Compute exact chars for the last 14 messages (msgs 41 to 54) using renderMessage
    const last14 = snapshot.messages.slice(54 - 14);
    let exact14Chars = 0;
    for (const m of last14) {
      exact14Chars += renderMessage(m, blobs).length;
    }

    const handoff = buildHandoff(snapshot, blobs, 'gemini', {
      maxActivePromptChars: exact14Chars,
    });

    expect(handoff.metadata.sourceMessageCount).toBe(54);
    expect(handoff.metadata.inlineMessageCount).toBe(14);
    expect(handoff.stats.sourceMessageCount).toBe(54);
    expect(handoff.stats.inlineMessageCount).toBe(14);
    expect(handoff.metadata.hasAttachedTranscript).toBe(true);
    // Ensure it NEVER claims "Total Messages Transferred: 14"
    expect(handoff.promptText).not.toContain('Total Messages Transferred: 14');
    expect(handoff.promptText).toContain('**Source Messages:** 54');
    expect(handoff.promptText).toContain('**Inline Context Messages:** 14');
  });

  it('Requirement 4: fullTranscriptMarkdown contains all 54 messages', () => {
    const snapshot = create54MessageSnapshot();
    const blobs = createTestBlobs();

    const handoff = buildHandoff(snapshot, blobs, 'gemini', {
      maxActivePromptTokens: 500, // force truncation inline
    });

    expect(handoff.metadata.transcriptMessageCount).toBe(54);
    for (let i = 1; i <= 54; i++) {
      expect(handoff.fullTranscriptMarkdown).toContain(`## Message ${i} —`);
    }

    // Also verify transcript.md attachment has all 54 messages
    const transcriptFile = handoff.attachments.find((f) => f.filename === 'transcript.md');
    expect(transcriptFile).toBeDefined();
    const decodedTranscript = new TextDecoder().decode(transcriptFile?.data);
    expect(decodedTranscript).toContain('## Message 1 — User');
    expect(decodedTranscript).toContain('## Message 54 — Assistant');
  });

  it('Requirement 5: Never claims "complete transcript attached" unless transcript.md is part of outgoing attachments', () => {
    const snapshot = create54MessageSnapshot();
    const blobs = createTestBlobs();

    // Case A: Truncated -> transcript.md IS attached and prompt claims it
    const truncatedHandoff = buildHandoff(snapshot, blobs, 'gemini', {
      maxActivePromptTokens: 500,
    });
    expect(truncatedHandoff.metadata.hasAttachedTranscript).toBe(true);
    expect(truncatedHandoff.attachments.some((f) => f.filename === 'transcript.md')).toBe(true);
    expect(truncatedHandoff.promptText).toContain('transcript.md');

    // Case B: Full (all fit inline) -> transcript.md is NOT attached and prompt does NOT claim it
    const fullHandoff = buildHandoff(snapshot, blobs, 'gemini', {
      strategy: 'FULL',
    });
    expect(fullHandoff.metadata.hasAttachedTranscript).toBe(false);
    expect(fullHandoff.attachments.some((f) => f.filename === 'transcript.md')).toBe(false);
    expect(fullHandoff.promptText).not.toContain('transcript.md');
    expect(fullHandoff.promptText).not.toContain('attached as a reference document');
  });

  it('Requirement 6: Original PNG bytes are reconstructed and attached separately', () => {
    const snapshot = create54MessageSnapshot();
    const blobs = createTestBlobs();

    const handoff = buildHandoff(snapshot, blobs, 'gemini');

    const pngAttachment = handoff.attachments.find((f) => f.filename === 'screenshot.png');
    expect(pngAttachment).toBeDefined();
    expect(pngAttachment?.mimeType).toBe('image/png');
    expect(pngAttachment?.data).toEqual(pngBytes);
  });

  it('Requirement 7: Prompt begins with readable natural language continuation instructions, never CTXBRDG1 or binary data', () => {
    const snapshot = create54MessageSnapshot();
    const blobs = createTestBlobs();

    const handoff = buildHandoff(snapshot, blobs, 'gemini');

    // Starts with readable instruction text
    expect(handoff.promptText.startsWith('You are continuing an existing conversation')).toBe(true);
    // Never starts with or contains binary header
    expect(handoff.promptText.startsWith('CTXBRDG1')).toBe(false);
    expect(handoff.promptText).not.toContain('CTXBRDG1');
    // Ensure no unprintable non-ASCII control characters that denote raw binary
    expect(/[\x00-\x08\x0E-\x1F]/.test(handoff.promptText)).toBe(false);
  });
});
