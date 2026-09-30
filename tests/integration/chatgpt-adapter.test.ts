import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatGPTAdapter } from '../../src/adapters/chatgpt/adapter';
import {
  extractChatGPTMessage,
  extractChatGPTTurn,
  parseRoleFromUnitKey,
  extractMessageId,
} from '../../src/adapters/chatgpt/extractor';
import { buildArchive } from '../../src/core/archive/writer';
import { readArchive } from '../../src/core/archive/reader';
import { injectChatGPTImport } from '../../src/adapters/chatgpt/importer';
import { PreparedHandoff } from '../../src/core/handoff/strategies';

describe('ChatGPT Adapter Integration with Modern Live DOM Fixture', () => {
  function getFixtureDocument(): Document {
    const fixtureHtml = fs.readFileSync(
      path.join(__dirname, '../fixtures/chatgpt-dom.html'),
      'utf-8'
    );
    const window = new Window({ url: 'https://chatgpt.com/c/sample-thread' });
    window.document.write(fixtureHtml);
    return window.document as unknown as Document;
  }

  const adapter = new ChatGPTAdapter();

  it('detects ChatGPT URLs properly', () => {
    expect(adapter.detect('https://chatgpt.com/c/123')).toBe(true);
    expect(adapter.detect('https://chat.openai.com/g/123')).toBe(true);
    expect(adapter.detect('https://claude.ai/chat/123')).toBe(false);
  });

  it('extracts conversation metadata from document.title ignoring sidebar link', async () => {
    const doc = getFixtureDocument();
    const meta = await adapter.getConversationMetadata(doc);

    expect(meta.title).toBe('Optimizing Redis Cache');
    expect(meta.id).toBe('test-conv-uuid');
  });

  it('parses roles robustly from unit keys and handles unknown future roles', () => {
    expect(parseRoleFromUnitKey('fallback-turn-4:0:user')).toEqual({ role: 'user' });
    expect(parseRoleFromUnitKey('fallback-turn-4:2:assistant')).toEqual({ role: 'assistant' });
    expect(parseRoleFromUnitKey('fallback-turn-9:1:tool')).toEqual({ role: 'tool' });
    expect(parseRoleFromUnitKey('turn-10:system')).toEqual({ role: 'system' });

    // Unknown role: does not crash, preserves token
    const unknown = parseRoleFromUnitKey('fallback-turn-5:3:thinking_canvas');
    expect(unknown.role).toBe('assistant');
    expect(unknown.originalRoleToken).toBe('thinking_canvas');
  });

  it('extracts real provider message IDs', () => {
    const doc = getFixtureDocument();
    const userUnit = doc.querySelector('[data-content-search-unit-key$=":user"]')!;
    const asstUnit = doc.querySelector('[data-content-search-unit-key$=":assistant"]')!;

    expect(extractMessageId(userUnit, 'fallback-id')).toBe('msg-user-1');
    expect(extractMessageId(asstUnit, 'fallback-id')).toBe('msg-asst-1');
  });

  it('extracts user turn with uploaded PNG and resolves binary to BlobStore (Bug 2 fix)', async () => {
    const doc = getFixtureDocument();
    const { snapshot, blobs } = await adapter.captureConversation(
      { includeAttachments: true },
      undefined,
      undefined,
      doc
    );

    // Verify attachments were captured
    expect(snapshot.attachments.length).toBeGreaterThanOrEqual(1);
    expect(blobs.size).toBeGreaterThanOrEqual(1);

    const userMsg = snapshot.messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();

    // Verify user message contains image content part referencing the stored blob
    const imgPart = userMsg?.content.find((p) => p.type === 'image' || p.type === 'file');
    expect(imgPart).toBeDefined();
    if (imgPart && (imgPart.type === 'image' || imgPart.type === 'file')) {
      const blob = blobs.get(imgPart.blobSha256);
      expect(blob).toBeDefined();
      expect(blob?.data.length).toBeGreaterThan(0);
      expect(blob?.metadata.sha256).toBe(imgPart.blobSha256);
    }
  });

  it('preserves strict text-code-text-code-text document order without dropping code (Bug 3 fix)', async () => {
    const doc = getFixtureDocument();
    const { snapshot, blobs } = await adapter.captureConversation(
      { includeAttachments: true },
      undefined,
      undefined,
      doc
    );

    const asstMsg = snapshot.messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();

    const parts = asstMsg!.content;

    // Verify parts order: text -> code -> text -> code -> text -> code -> text -> table
    expect(parts[0]?.type).toBe('text');
    expect(parts[0]?.type === 'text' && parts[0].text).toContain('Run this command first');

    expect(parts[1]?.type).toBe('code');
    if (parts[1]?.type === 'code') {
      expect(parts[1].language).toBe('bash');
      expect(parts[1].code).toContain('pip install redis');
    }

    expect(parts[2]?.type).toBe('text');
    expect(parts[2]?.type === 'text' && parts[2].text).toContain('then configure the connection pool');

    expect(parts[3]?.type).toBe('code');
    if (parts[3]?.type === 'code') {
      expect(parts[3].language).toBe('python');
      expect(parts[3].code).toContain('import redis');
    }

    expect(parts[4]?.type).toBe('text');
    expect(parts[4]?.type === 'text' && parts[4].text).toContain('and this is how you verify');

    expect(parts[5]?.type).toBe('code');
    if (parts[5]?.type === 'code') {
      expect(parts[5].language).toBe('python');
      expect(parts[5].code).toContain('print(r.ping())');
    }

    expect(parts[6]?.type).toBe('text');
    expect(parts[6]?.type === 'text' && parts[6].text).toContain('Everything should now run cleanly');

    // Archive roundtrip: verify exact parts and order survive roundtrip
    const archiveBytes = await buildArchive(snapshot, blobs, { compress: true });
    const loaded = await readArchive(archiveBytes);

    const roundtripAsst = loaded.snapshot.messages.find((m) => m.role === 'assistant');
    expect(roundtripAsst).toBeDefined();
    expect(roundtripAsst?.content.map((p) => p.type)).toEqual(parts.map((p) => p.type));
  });

  it('reports all required live diagnostics and crawler verification metrics (Bug 1 diagnostics)', async () => {
    const doc = getFixtureDocument();
    await adapter.captureConversation({}, undefined, undefined, doc);
    const diag = await adapter.getDiagnostics(doc);

    expect(diag.chatgptTurnCount).toBe(2);
    expect(diag.chatgptUnitCount).toBe(2);
    expect(diag.messageIdsFound).toBe(2);
    expect(diag.conversationIdFound).toBe(true);
    expect(diag.capturedMessageCount).toBe(2);
    expect(diag.scrollContainerDescription).toBeDefined();
    expect(diag.beginningReached).toBe(true);
  });

  it('supports legacy DOM fallbacks seamlessly', () => {
    const window = new Window();
    const legacyDoc = window.document;
    legacyDoc.body.innerHTML = `
      <article data-testid="conversation-turn-legacy" data-message-author-role="assistant">
        <div class="markdown"><p>Legacy message content</p></div>
      </article>
    `;

    const article = legacyDoc.querySelector('article')!;
    const extracted = extractChatGPTMessage(article as unknown as Element, 1);
    expect(extracted).toBeDefined();
    expect(extracted?.message.role).toBe('assistant');
    expect(extracted?.message.content[0]?.type === 'text' && extracted.message.content[0].text).toBe(
      'Legacy message content'
    );
  });

  it('injects handoff draft into compose box', async () => {
    const doc = getFixtureDocument();
    const sampleHandoff: PreparedHandoff = {
      targetPlatform: 'chatgpt',
      strategy: 'RECENT_PLUS_ARCHIVE',
      promptText: 'Bootstrap prompt continuation text...',
      files: [],
      stats: {
        totalMessages: 2,
        activePromptMessages: 2,
        attachedFilesCount: 0,
        estimatedTokens: 10,
        isTruncatedToRecent: false,
      },
    };

    const result = await injectChatGPTImport(sampleHandoff, doc);
    expect(result.success).toBe(true);

    const textarea = doc.querySelector('#prompt-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Bootstrap prompt continuation text...');
  });

  it('extracts non-PRE assistant code containers with copy buttons as structured code parts in strict order', () => {
    const window = new Window();
    const doc = window.document;
    doc.body.innerHTML = `
      <div data-turn-key="test-turn-key">
        <div data-content-search-turn-key="fallback-turn-0">
          <div data-content-search-unit-key="fallback-turn-0:2:assistant">
            <div data-chatgpt-selection-message-id="test-msg-id">
              <div data-markdown-text-style="assistant-message">
                <p>First step text:</p>
                <div class="code-block-container bg-token-surface">
                  <div class="code-header flex justify-between">
                    <span>python</span>
                    <button aria-label="Copy code">Copy code</button>
                  </div>
                  <div class="code-body">
                    <code class="hljs language-python">def calculate_total(a, b):
    return a + b</code>
                  </div>
                </div>
                <p>Middle explanation text.</p>
                <div class="code-block-container">
                  <pre class="overflow-x-auto"><code class="language-bash">npm test</code></pre>
                </div>
                <p>Final concluding text.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const turnEl = doc.querySelector('[data-turn-key]')!;
    const extractedList = extractChatGPTTurn(turnEl as unknown as Element, 1);
    expect(extractedList).toHaveLength(1);

    const msg = extractedList[0]!.message;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toHaveLength(5);

    expect(msg.content[0]?.type).toBe('text');
    expect(msg.content[0]?.type === 'text' && msg.content[0].text).toBe('First step text:');

    expect(msg.content[1]?.type).toBe('code');
    if (msg.content[1]?.type === 'code') {
      expect(msg.content[1].language).toBe('python');
      expect(msg.content[1].code).toBe('def calculate_total(a, b):\n    return a + b');
    }

    expect(msg.content[2]?.type).toBe('text');
    expect(msg.content[2]?.type === 'text' && msg.content[2].text).toBe('Middle explanation text.');

    expect(msg.content[3]?.type).toBe('code');
    if (msg.content[3]?.type === 'code') {
      expect(msg.content[3].language).toBe('bash');
      expect(msg.content[3].code).toBe('npm test');
    }

    expect(msg.content[4]?.type).toBe('text');
    expect(msg.content[4]?.type === 'text' && msg.content[4].text).toBe('Final concluding text.');
  });
});
