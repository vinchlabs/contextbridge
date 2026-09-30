import { describe, it, expect, vi } from 'vitest';
import { Window } from 'happy-dom';
import { findUserFileCards, isPlausibleFilename } from '../../src/adapters/chatgpt/file-card-detector';
import { extractChatGPTTurn } from '../../src/adapters/chatgpt/extractor';
import { probeResourceCard } from '../../src/adapters/chatgpt/resource-card-probe';
import { crawlChatGPTConversation } from '../../src/adapters/chatgpt/crawler';
import { CaptureIncompleteError } from '../../src/core/errors/errors';

describe('ChatGPT Authoritative File Card Detection & Probing', () => {
  it('isPlausibleFilename correctly identifies filenames and rejects action phrases', () => {
    expect(isPlausibleFilename('перенос-чата-2026-01-15(2).ctxbridge')).toBe(true);
    expect(isPlausibleFilename('заметки.ctxbridge')).toBe(true);
    expect(isPlausibleFilename('Вставленный текст(20260115-120000).txt')).toBe(true);
    expect(isPlausibleFilename('document.pdf')).toBe(true);
    expect(isPlausibleFilename('data.csv')).toBe(true);

    // Rejects common UI action phrases
    expect(isPlausibleFilename('Edit message')).toBe(false);
    expect(isPlausibleFilename('Copy message')).toBe(false);
    expect(isPlausibleFilename('Read aloud')).toBe(false);
    expect(isPlausibleFilename('Attach files')).toBe(false);
    expect(isPlausibleFilename('Send message')).toBe(false);
    expect(isPlausibleFilename('Good response')).toBe(false);
    expect(isPlausibleFilename('Bad response')).toBe(false);
    expect(isPlausibleFilename('')).toBe(false);
    expect(isPlausibleFilename('wordwithoutdot')).toBe(false);
  });

  it('findUserFileCards locates file-card buttons in live sibling container structure', () => {
    const window = new Window();
    const doc = window.document;

    const turnDiv = doc.createElement('div');
    turnDiv.setAttribute('data-turn-key', 'turn-uuid-1');
    turnDiv.innerHTML = `
      <div class="user-turn-wrapper">
        <div class="group/user-message flex flex-col items-end gap-2" data-chatgpt-search-unit-key="fallback-turn-1:0:user" data-chatgpt-search-message-ids="msg-uuid-user">
          <div class="w-full" data-content-search-unit-key="fallback-turn-1:0:user">
            <p>Please check this export archive.</p>
          </div>
        </div>
        <div class="flex w-full flex-wrap justify-end gap-2 self-end md:w-4/5">
          <button
            type="button"
            aria-label="перенос-чата-2026-01-15(2).ctxbridge"
            class="peer/resource-card inline-flex items-center"
          >
            <span
              class="truncate text-default text-sm font-semibold"
              title="перенос-чата-2026-01-15(2).ctxbridge"
            >
              перенос-чата-2026-01-15(2).ctxbridge
            </span>
          </button>
        </div>
      </div>
      <div class="assistant-turn-wrapper" data-content-search-unit-key="fallback-turn-1:2:assistant">
        <p>I reviewed the file.</p>
        <button type="button" aria-label="Copy message" class="btn-copy">Copy</button>
        <button type="button" aria-label="Read aloud">Read</button>
      </div>
    `;

    const userUnit = turnDiv.querySelector('[data-content-search-unit-key="fallback-turn-1:0:user"]')!;
    const cards = findUserFileCards(turnDiv as unknown as Element, userUnit as unknown as Element, 'turn-uuid-1');

    expect(cards).toHaveLength(1);
    expect(cards[0]!.filename).toBe('перенос-чата-2026-01-15(2).ctxbridge');
    expect(cards[0]!.isResourceCardClass).toBe(true);
    expect(cards[0]!.turnKey).toBe('turn-uuid-1');
    expect(cards[0]!.spanTitle).toBe('перенос-чата-2026-01-15(2).ctxbridge');
  });

  it('findUserFileCards ignores buttons in assistant subtrees and standard action buttons', () => {
    const window = new Window();
    const doc = window.document;

    const turnDiv = doc.createElement('div');
    turnDiv.setAttribute('data-turn-key', 'turn-uuid-2');
    turnDiv.innerHTML = `
      <div class="assistant-sub" data-content-search-unit-key="fallback-turn-2:2:assistant">
        <button type="button" aria-label="output-code.py" class="peer/resource-card">
          <span title="output-code.py">output-code.py</span>
        </button>
      </div>
      <div class="user-sub">
        <button type="button" aria-label="Edit message">Edit</button>
      </div>
    `;

    const cards = findUserFileCards(turnDiv as unknown as Element, undefined, 'turn-uuid-2');
    expect(cards).toHaveLength(0);
  });

  it('extractChatGPTTurn detects file cards alongside text in user message', () => {
    const window = new Window();
    const doc = window.document;

    const turnDiv = doc.createElement('div');
    turnDiv.setAttribute('data-turn-key', 'turn-uuid-3');
    turnDiv.innerHTML = `
      <div>
        <div data-content-search-unit-key="fallback-turn-3:0:user">
          <p>Here is my text file:</p>
        </div>
        <div class="sibling-files">
          <button
            type="button"
            aria-label="Вставленный текст(20260115-120000).txt"
            class="peer/resource-card"
          >
            <span title="Вставленный текст(20260115-120000).txt">
              Вставленный текст(20260115-120000).txt
            </span>
          </button>
        </div>
        <div data-content-search-unit-key="fallback-turn-3:2:assistant">
          <div data-markdown-text-style="assistant-message">
            <p>I received the file.</p>
          </div>
        </div>
      </div>
    `;

    const results = extractChatGPTTurn(turnDiv as unknown as Element, 1);
    expect(results).toHaveLength(2);

    const userResult = results[0]!;
    expect(userResult.message.role).toBe('user');
    expect(userResult.detectedFileCards).toHaveLength(1);
    expect(userResult.detectedFileCards![0]!.filename).toBe('Вставленный текст(20260115-120000).txt');

    // User message contains both text and file parts
    const textParts = userResult.message.content.filter((p) => p.type === 'text');
    const fileParts = userResult.message.content.filter((p) => p.type === 'file');
    expect(textParts).toHaveLength(1);
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0]!.type === 'file' && fileParts[0]!.filename).toBe('Вставленный текст(20260115-120000).txt');
  });

  it('extractChatGPTTurn synthesizes user message when turn contains only a file card', () => {
    const window = new Window();
    const doc = window.document;

    const turnDiv = doc.createElement('div');
    turnDiv.setAttribute('data-turn-key', 'turn-uuid-4');
    turnDiv.innerHTML = `
      <div>
        <div class="user-file-container">
          <button
            type="button"
            aria-label="заметки.ctxbridge"
            class="peer/resource-card"
          >
            <span title="заметки.ctxbridge">заметки.ctxbridge</span>
          </button>
        </div>
        <div data-content-search-unit-key="fallback-turn-4:2:assistant">
          <div data-markdown-text-style="assistant-message">
            <p>Assistant response to file.</p>
          </div>
        </div>
      </div>
    `;

    const results = extractChatGPTTurn(turnDiv as unknown as Element, 1);
    expect(results).toHaveLength(2);

    const userMsg = results[0]!;
    expect(userMsg.message.role).toBe('user');
    expect(userMsg.detectedFileCards).toHaveLength(1);
    expect(userMsg.detectedFileCards![0]!.filename).toBe('заметки.ctxbridge');

    const fileParts = userMsg.message.content.filter((p) => p.type === 'file');
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0]!.type === 'file' && fileParts[0]!.filename).toBe('заметки.ctxbridge');
  });

  it('fail-closed accounting: crawler fails closed when fileCardsUnresolved > 0', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <main style="overflow-y: auto; height: 600px;">
        <div data-virtualized-turn-content class="react-scroll-to-bottom--container">
          <div data-turn-key="turn-0-failclosed">
            <div data-content-search-unit-key="fallback-turn-0:0:user">
              <p>User message</p>
            </div>
            <div class="file-sibling">
              <button
                type="button"
                aria-label="test-upload.ctxbridge"
                class="peer/resource-card"
              >
                <span title="test-upload.ctxbridge">test-upload.ctxbridge</span>
              </button>
            </div>
            <div data-content-search-unit-key="fallback-turn-0:2:assistant">
              <div data-markdown-text-style="assistant-message">
                <p>Assistant message</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    `;

    let capturedError: CaptureIncompleteError | null = null;
    try {
      // The diagnostic probe is opt-in since real byte capture replaced it as the default path.
      await crawlChatGPTConversation(doc as unknown as Document, {
        maxScrollAttempts: 2,
        probeTimeoutMs: 50,
        resourceCardProbe: true,
      });
    } catch (err: any) {
      if (err instanceof CaptureIncompleteError) {
        capturedError = err;
      }
    }

    expect(capturedError).not.toBeNull();
    expect(capturedError!.message).toContain('user file card(s) could not be resolved to real file bytes');
    const details = capturedError!.details as Record<string, any>;
    expect(details.fileCardsDetected).toBe(1);
    expect(details.fileCardsResolved).toBe(0);
    expect(details.fileCardsUnresolved).toBe(1);
    expect(details.terminationReason).toBe('unresolved_user_attachment');
    expect(details.resourceCardProbeAttempts).toBe(1);
    expect(details.resourceCardProbes).toBeDefined();
    expect(details.resourceCardProbes.length).toBe(1);
    expect(details.resourceCardProbes[0].filename).toBe('test-upload.ctxbridge');
    expect(details.resourceCardProbes[0].attempted).toBe(true);
    expect(details.resourceCardProbes[0].elementWasConnected).toBe(true);
  });

  it('probeResourceCard activates button, gathers diagnostics, and restores UI state', async () => {
    const window = new Window();
    const doc = window.document;

    const btn = doc.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'заметки.ctxbridge');
    btn.className = 'peer/resource-card';

    const span = doc.createElement('span');
    span.setAttribute('title', 'заметки.ctxbridge');
    span.textContent = 'заметки.ctxbridge';
    btn.appendChild(span);
    doc.body.appendChild(btn);

    let clickObserved = false;
    btn.addEventListener('click', () => {
      clickObserved = true;
      // Simulate opening a preview modal upon click
      const modal = doc.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.className = 'preview-modal';
      modal.innerHTML = `
        <h3>Preview: заметки.ctxbridge</h3>
        <a href="https://chatgpt.com/files/download-123">Download</a>
        <button type="button" aria-label="Close dialog" class="close-btn">Close</button>
      `;
      doc.body.appendChild(modal);
    });

    const card = {
      buttonEl: btn as unknown as HTMLButtonElement,
      filename: 'заметки.ctxbridge',
      ariaLabel: 'заметки.ctxbridge',
      spanTitle: 'заметки.ctxbridge',
      turnKey: 'turn-test-probe',
      isResourceCardClass: true,
    };

    const probeResult = await probeResourceCard(card, doc as unknown as Document, { probeTimeoutMs: 50 });

    expect(clickObserved).toBe(true);
    expect(probeResult.filename).toBe('заметки.ctxbridge');
    expect(probeResult.turnKey).toBe('turn-test-probe');
    expect(probeResult.attempted).toBe(true);
    expect(probeResult.elementWasConnected).toBe(true);
    expect(probeResult.result).toBe('modal_opened');
    expect(probeResult.error).toBeNull();
    expect(probeResult.newModalsOrDialogs).toBeDefined();
    expect(probeResult.newModalsOrDialogs!.length).toBeGreaterThan(0);
    expect(probeResult.observedUrls).toBeDefined();
    expect(probeResult.observedUrls!.some((u) => u.sanitizedUrl.includes('download-123'))).toBe(true);
    expect(probeResult.outcome).toBe('modal_opened');
  });

  it('probeResourceCard records failure state safely when element is not connected', async () => {
    const card = {
      buttonEl: { isConnected: false, className: 'peer/resource-card' } as unknown as HTMLButtonElement,
      filename: 'detached.ctxbridge',
      ariaLabel: 'detached.ctxbridge',
      spanTitle: 'detached.ctxbridge',
      turnKey: 'turn-detached',
      isResourceCardClass: true,
    };
    const res = await probeResourceCard(card);
    expect(res.attempted).toBe(true);
    expect(res.elementWasConnected).toBe(false);
    expect(res.result).toBe('element_not_connected');
    expect(res.error).toContain('not connected');
  });
});
