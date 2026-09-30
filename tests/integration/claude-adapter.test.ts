import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ClaudeAdapter } from '../../src/adapters/claude/adapter';
import { extractClaudeMessage } from '../../src/adapters/claude/extractor';
import { injectClaudeImport } from '../../src/adapters/claude/importer';
import { PreparedHandoff } from '../../src/core/handoff/strategies';

describe('Claude Adapter Integration with DOM Fixture', () => {
  function getFixtureDocument(): Document {
    const fixtureHtml = fs.readFileSync(
      path.join(__dirname, '../fixtures/claude-dom.html'),
      'utf-8'
    );
    const window = new Window({ url: 'https://claude.ai/chat/sample-chat-123' });
    window.document.write(fixtureHtml);
    return window.document as unknown as Document;
  }

  const adapter = new ClaudeAdapter();

  it('detects Claude URLs', () => {
    expect(adapter.detect('https://claude.ai/chat/123')).toBe(true);
    expect(adapter.detect('https://gemini.google.com')).toBe(false);
  });

  it('extracts metadata from title', async () => {
    const doc = getFixtureDocument();
    const meta = await adapter.getConversationMetadata(doc);
    expect(meta.title).toBe('React Performance Optimization');
  });

  it('extracts user turn with code file attachment', () => {
    const doc = getFixtureDocument();
    const userTurn = doc.querySelector('[data-testid="user-message"]')!;
    const extracted = extractClaudeMessage(userTurn, 1);

    expect(extracted).toBeDefined();
    expect(extracted?.message.role).toBe('user');

    const filePart = extracted?.message.content.find((p) => p.type === 'file');
    expect(filePart).toBeDefined();
    if (filePart && filePart.type === 'file') {
      expect(filePart.filename).toBe('SlowComponent.tsx');
    }
  });

  it('extracts assistant message with TypeScript code and table', () => {
    const doc = getFixtureDocument();
    const assistantTurn = doc.querySelector('[data-testid="claude-message-1"]')!;
    const extracted = extractClaudeMessage(assistantTurn, 2);

    expect(extracted).toBeDefined();
    expect(extracted?.message.role).toBe('assistant');

    const codePart = extracted?.message.content.find((p) => p.type === 'code');
    expect(codePart).toBeDefined();
    if (codePart && codePart.type === 'code') {
      expect(codePart.language).toBe('typescript');
      expect(codePart.code).toContain('export function OptimizedList');
    }

    const tablePart = extracted?.message.content.find((p) => p.type === 'table');
    expect(tablePart).toBeDefined();
    if (tablePart && tablePart.type === 'table') {
      expect(tablePart.headers).toEqual(['Hook', 'Use Case']);
      expect(tablePart.rows).toHaveLength(2);
    }
  });

  it('injects handoff draft into Claude composer', async () => {
    const doc = getFixtureDocument();
    const sampleHandoff: PreparedHandoff = {
      targetPlatform: 'claude',
      strategy: 'RECENT_PLUS_ARCHIVE',
      promptText: 'Drafted Claude prompt continuation...',
      files: [],
      stats: {
        totalMessages: 2,
        activePromptMessages: 2,
        attachedFilesCount: 0,
        estimatedTokens: 8,
        isTruncatedToRecent: false,
      },
    };

    const result = await injectClaudeImport(sampleHandoff, doc);
    expect(result.success).toBe(true);

    const composer = doc.querySelector('.composer div[contenteditable="true"]')!;
    expect(composer.textContent).toBe('Drafted Claude prompt continuation...');
  });
});
