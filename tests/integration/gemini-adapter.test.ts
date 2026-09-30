import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GeminiAdapter } from '../../src/adapters/gemini/adapter';
import { extractGeminiMessage } from '../../src/adapters/gemini/extractor';
import { injectGeminiImport } from '../../src/adapters/gemini/importer';
import { PreparedHandoff } from '../../src/core/handoff/strategies';

describe('Gemini Adapter Integration with DOM Fixture', () => {
  function getFixtureDocument(): Document {
    const fixtureHtml = fs.readFileSync(
      path.join(__dirname, '../fixtures/gemini-dom.html'),
      'utf-8'
    );
    const window = new Window({ url: 'https://gemini.google.com/app/sample-chat' });
    window.document.write(fixtureHtml);
    return window.document as unknown as Document;
  }

  const adapter = new GeminiAdapter();

  it('detects Gemini URLs', () => {
    expect(adapter.detect('https://gemini.google.com/app')).toBe(true);
    expect(adapter.detect('https://chatgpt.com')).toBe(false);
  });

  it('extracts metadata from title', async () => {
    const doc = getFixtureDocument();
    const meta = await adapter.getConversationMetadata(doc);
    expect(meta.title).toBe('Database Indexing Guide');
  });

  it('extracts user query with attached schema image', () => {
    const doc = getFixtureDocument();
    const userTurn = doc.querySelector('user-query')!;
    const extracted = extractGeminiMessage(userTurn, 1);

    expect(extracted).toBeDefined();
    expect(extracted?.message.role).toBe('user');
    expect(extracted?.mediaRefs).toHaveLength(1);
    expect(extracted?.mediaRefs[0]?.url).toBe('https://gemini.google.com/uploads/query-schema.png');
  });

  it('extracts model response with SQL code block and table', () => {
    const doc = getFixtureDocument();
    const modelTurn = doc.querySelector('model-response')!;
    const extracted = extractGeminiMessage(modelTurn, 2);

    expect(extracted).toBeDefined();
    expect(extracted?.message.role).toBe('assistant');

    const codePart = extracted?.message.content.find((p) => p.type === 'code');
    expect(codePart).toBeDefined();
    if (codePart && codePart.type === 'code') {
      expect(codePart.language).toBe('sql');
      expect(codePart.code).toContain('CREATE INDEX idx_users_email');
    }

    const tablePart = extracted?.message.content.find((p) => p.type === 'table');
    expect(tablePart).toBeDefined();
    if (tablePart && tablePart.type === 'table') {
      expect(tablePart.headers).toEqual(['Index Type', 'Best For']);
    }
  });

  it('injects handoff draft into Gemini compose box', async () => {
    const doc = getFixtureDocument();
    const sampleHandoff: PreparedHandoff = {
      targetPlatform: 'gemini',
      strategy: 'RECENT_PLUS_ARCHIVE',
      promptText: 'Drafted Gemini prompt continuation...',
      files: [],
      stats: {
        totalMessages: 2,
        activePromptMessages: 2,
        attachedFilesCount: 0,
        estimatedTokens: 8,
        isTruncatedToRecent: false,
      },
    };

    const result = await injectGeminiImport(sampleHandoff, doc);
    expect(result.success).toBe(true);

    const composer = doc.querySelector('rich-textarea div[contenteditable="true"]')!;
    expect(composer.textContent).toBe('Drafted Gemini prompt continuation...');
  });
});
