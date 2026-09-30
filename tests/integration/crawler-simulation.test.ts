import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Window } from 'happy-dom';
import { crawlChatGPTConversation } from '../../src/adapters/chatgpt/crawler';
import { ChatGPTAdapter } from '../../src/adapters/chatgpt/adapter';
import { CaptureIncompleteError } from '../../src/core/errors/errors';
import { loadLastChatGPTDiagnostics } from '../../src/storage/chatgpt-diagnostics-store';

describe('Virtual DOM Crawler Simulation with Live ChatGPT Virtualization', () => {
  it('crawls virtualized history with 4-turn sliding window, deduplicates by real message ID, and verifies beginningReached', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <main style="overflow-y: auto; height: 600px;">
        <div data-virtualized-turn-content class="react-scroll-to-bottom--container">
          <div id="turn-container"></div>
        </div>
      </main>
    `;

    const container = doc.querySelector('main') as unknown as HTMLElement;
    const turnContainer = doc.querySelector('#turn-container') as unknown as HTMLElement;

    // Total 8 turns: 1 user unit + 1 assistant unit = 16 messages total
    const turnsDataset = Array.from({ length: 8 }, (_, t) => ({
      turnIndex: t,
      turnUuid: `uuid-turn-${t}`,
      turnKey: `fallback-turn-${t}`,
      userMsgId: `msg-id-${t}-user`,
      asstMsgId: `msg-id-${t}-assistant`,
      userText: `User question for turn ${t}`,
      asstText: `Assistant response for turn ${t}`,
    }));

    // Start with only latest 4 turns mounted (turns 4, 5, 6, 7)
    let windowStart = 4;
    const windowSize = 4;

    function renderSlidingWindow() {
      turnContainer.innerHTML = '';
      const visibleTurns = turnsDataset.slice(windowStart, windowStart + windowSize);
      for (const t of visibleTurns) {
        const turnDiv = doc.createElement('div');
        turnDiv.setAttribute('data-turn-key', t.turnUuid);
        turnDiv.innerHTML = `
          <div data-content-search-turn-key="${t.turnKey}">
            <div
              data-content-search-unit-key="${t.turnKey}:0:user"
              data-chatgpt-search-unit-key="${t.turnKey}:0:user"
              data-chatgpt-search-message-ids="${t.userMsgId}"
            >
              <div
                data-chatgpt-selection-conversation-id="conv-session-123"
                data-chatgpt-selection-message-id="${t.userMsgId}"
              >
                <p>${t.userText}</p>
              </div>
            </div>
            <div
              data-content-search-unit-key="${t.turnKey}:2:assistant"
              data-chatgpt-search-unit-key="${t.turnKey}:2:assistant"
              data-chatgpt-search-message-ids="${t.asstMsgId}"
            >
              <div
                data-chatgpt-selection-conversation-id="conv-session-123"
                data-chatgpt-selection-message-id="${t.asstMsgId}"
              >
                <div data-markdown-text-style="assistant-message">
                  <p>${t.asstText}</p>
                </div>
              </div>
            </div>
          </div>
        `;
        turnContainer.appendChild(turnDiv as unknown as Node);
      }
    }

    renderSlidingWindow();
    let currentScrollTop = 2000;

    Object.defineProperty(container, 'scrollTop', {
      get() {
        return currentScrollTop;
      },
      set(val: number) {
        currentScrollTop = Math.max(0, val);
        if (currentScrollTop < 2000 && windowStart > 0) {
          windowStart = Math.max(0, windowStart - 2);
          renderSlidingWindow();
        }
      },
      configurable: true,
    });

    Object.defineProperty(container, 'scrollHeight', {
      get() {
        return 3000;
      },
      configurable: true,
    });

    Object.defineProperty(container, 'clientHeight', {
      get() {
        return 600;
      },
      configurable: true,
    });

    const crawlResult = await crawlChatGPTConversation(doc as unknown as Document, {
      maxScrollAttempts: 30,
      scrollDelayMs: 20,
    });

    expect(crawlResult.results).toHaveLength(16);
    expect(crawlResult.beginningReached).toBe(true);
    expect(crawlResult.oldestTurnKeySeen).toContain('turn-0');

    // Sequential ordering 1..16
    const sequenceNumbers = crawlResult.results.map((r) => r.message.sequence);
    expect(sequenceNumbers).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));

    // Exact chronological order
    const expectedIds = turnsDataset.flatMap((t) => [t.userMsgId, t.asstMsgId]);
    const actualIds = crawlResult.results.map((r) => r.message.id);
    expect(actualIds).toEqual(expectedIds);
  });

  it('fails with CaptureIncompleteError if only the initial mounted window is captured (Bug 1 guarantee)', async () => {
    const window = new Window();
    const doc = window.document;

    // Page has 4 mounted turns (starting at turn 4), but scrolling does not work
    doc.body.innerHTML = `
      <main style="overflow-y: auto; height: 600px;">
        <div data-virtualized-turn-content>
          <div data-turn-key="turn-uuid-4">
            <div data-content-search-turn-key="fallback-turn-4">
              <div data-content-search-unit-key="fallback-turn-4:0:user" data-chatgpt-selection-message-id="msg-4">
                <p>Question 4</p>
              </div>
            </div>
          </div>
          <div data-turn-key="turn-uuid-5">
            <div data-content-search-turn-key="fallback-turn-5">
              <div data-content-search-unit-key="fallback-turn-5:0:user" data-chatgpt-selection-message-id="msg-5">
                <p>Question 5</p>
              </div>
            </div>
          </div>
        </div>
      </main>
    `;

    const container = doc.querySelector('main') as unknown as HTMLElement;
    let currentScrollTop = 0; // Fake top, but turns start at turn 4!

    Object.defineProperty(container, 'scrollTop', {
      get() {
        return currentScrollTop;
      },
      set(val: number) {
        currentScrollTop = val;
      },
      configurable: true,
    });

    // History traversal fails to discover earlier turns 0..3: MUST raise CaptureIncompleteError!
    await expect(
      crawlChatGPTConversation(doc as unknown as Document, {
        maxScrollAttempts: 5,
        scrollDelayMs: 10,
      })
    ).rejects.toThrow(CaptureIncompleteError);
  });

  it('probes candidate ancestors safely when initial candidate is not the true scrolling element', async () => {
    const window = new Window();
    const doc = window.document;

    // Grandparent is the true scrolling container
    doc.body.innerHTML = `
      <div id="true-scroller" style="overflow-y: auto; height: 600px;">
        <div id="inner-wrapper" style="overflow: visible;">
          <div data-virtualized-turn-content>
            <div id="turn-box"></div>
          </div>
        </div>
      </div>
    `;

    const trueScroller = doc.querySelector('#true-scroller') as unknown as HTMLElement;
    const turnBox = doc.querySelector('#turn-box') as unknown as HTMLElement;

    let turnsMounted = ['fallback-turn-2', 'fallback-turn-3'];
    function render() {
      turnBox.innerHTML = '';
      for (const t of turnsMounted) {
        const div = doc.createElement('div');
        div.setAttribute('data-turn-key', t);
        div.innerHTML = `
          <div data-content-search-turn-key="${t}">
            <div data-content-search-unit-key="${t}:0:user" data-chatgpt-selection-message-id="msg-${t}">
              <p>Text for ${t}</p>
            </div>
          </div>
        `;
        turnBox.appendChild(div as unknown as Node);
      }
    }
    render();

    let scrollTop = 1500;
    Object.defineProperty(trueScroller, 'scrollTop', {
      get() {
        return scrollTop;
      },
      set(val: number) {
        scrollTop = Math.max(0, val);
        if (scrollTop < 1500) {
          turnsMounted = ['fallback-turn-0', 'fallback-turn-1', 'fallback-turn-2', 'fallback-turn-3'];
          render();
        }
      },
      configurable: true,
    });

    Object.defineProperty(trueScroller, 'scrollHeight', {
      get() {
        return 2500;
      },
      configurable: true,
    });
    Object.defineProperty(trueScroller, 'clientHeight', {
      get() {
        return 600;
      },
      configurable: true,
    });

    const res = await crawlChatGPTConversation(doc as unknown as Document, {
      maxScrollAttempts: 15,
      scrollDelayMs: 15,
    });

    expect(res.results.length).toBe(4);
    expect(res.beginningReached).toBe(true);
    expect(res.newTurnsDiscovered).toBe(2);
  });

  it('successfully crawls modern ChatGPT [data-app-action-timeline-scroll] with column-reverse and negative scrollTop progression', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div
        data-app-action-timeline-scroll="true"
        style="display: flex; flex-direction: column-reverse; height: 1000px; overflow-y: auto;"
      >
        <div id="timeline-turns"></div>
      </div>
    `;

    const scroller = doc.querySelector('[data-app-action-timeline-scroll]') as unknown as HTMLElement;
    const turnContainer = doc.querySelector('#timeline-turns') as unknown as HTMLElement;

    // 8 turns: 1 user unit + 1 assistant unit = 16 messages total
    const turnsDataset = Array.from({ length: 8 }, (_, t) => ({
      turnIndex: t,
      turnUuid: `uuid-turn-5501d55c-turn-${t}`,
      turnKey: `fallback-turn-${t}`,
      userMsgId: `msg-id-${t}-user`,
      asstMsgId: `msg-id-${t}-assistant`,
      userText: `User question for turn ${t}`,
      asstText:
        t === 5
          ? `Here is the code block:\n<div class="code-block-wrapper"><div class="code-header"><span>python</span><button class="copy-btn">Copy code</button></div><pre><code class="language-python">def hello_world():\n    return "hello"</code></pre></div>\nAnd that is all.`
          : `Assistant response for turn ${t}`,
      hasCode: t === 5,
    }));

    let windowStart = 4;
    const windowSize = 4;

    function renderSlidingWindow() {
      turnContainer.innerHTML = '';
      const visibleTurns = turnsDataset.slice(windowStart, windowStart + windowSize);
      for (const t of visibleTurns) {
        const turnDiv = doc.createElement('div');
        turnDiv.setAttribute('data-turn-key', t.turnUuid);
        turnDiv.innerHTML = `
          <div data-content-search-turn-key="${t.turnKey}">
            <div
              data-content-search-unit-key="${t.turnKey}:0:user"
              data-chatgpt-search-unit-key="${t.turnKey}:0:user"
              data-chatgpt-search-message-ids="${t.userMsgId}"
            >
              <div
                data-chatgpt-selection-conversation-id="session-live-chat"
                data-chatgpt-selection-message-id="${t.userMsgId}"
              >
                <p>${t.userText}</p>
              </div>
            </div>
            <div
              data-content-search-unit-key="${t.turnKey}:2:assistant"
              data-chatgpt-search-unit-key="${t.turnKey}:2:assistant"
              data-chatgpt-search-message-ids="${t.asstMsgId}"
            >
              <div
                data-chatgpt-selection-conversation-id="session-live-chat"
                data-chatgpt-selection-message-id="${t.asstMsgId}"
              >
                <div data-markdown-text-style="assistant-message">
                  ${t.hasCode ? t.asstText : `<p>${t.asstText}</p>`}
                </div>
              </div>
            </div>
          </div>
        `;
        turnContainer.appendChild(turnDiv as unknown as Node);
      }
    }

    renderSlidingWindow();

    let currentScrollTop = -800;
    let currentScrollHeight = 16000;
    const clientHeight = 1000;

    Object.defineProperty(scroller, 'scrollTop', {
      get() {
        return currentScrollTop;
      },
      set(val: number) {
        // In column-reverse, negative values represent older history.
        // Direct assignment works natively in Firefox.
        if (val < currentScrollTop) {
          if (val <= -2400) {
            currentScrollTop = -3200; // Hit oldest boundary
            if (windowStart > 0) {
              windowStart = 0;
              currentScrollHeight = 16762;
              renderSlidingWindow();
            }
          } else if (val <= -1600) {
            currentScrollTop = val;
            if (windowStart > 2) {
              windowStart = 2;
              currentScrollHeight = 16643;
              renderSlidingWindow();
            }
          } else {
            currentScrollTop = val;
          }
        }
      },
      configurable: true,
    });

    Object.defineProperty(scroller, 'scrollHeight', {
      get() {
        return currentScrollHeight;
      },
      configurable: true,
    });

    Object.defineProperty(scroller, 'clientHeight', {
      get() {
        return clientHeight;
      },
      configurable: true,
    });

    const progressReports: any[] = [];
    const crawlResult = await crawlChatGPTConversation(
      doc as unknown as Document,
      {
        maxScrollAttempts: 25,
        scrollDelayMs: 15,
      },
      (p) => {
        progressReports.push(p);
      }
    );

    // Verify onProgress reports were triggered without TDZ error
    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[0].currentOperation).toContain('Crawling virtual history (pass 0');

    // 1. Verify message count and beginning reached
    expect(crawlResult.results).toHaveLength(16);
    expect(crawlResult.beginningReached).toBe(true);
    expect(crawlResult.terminationReason).toBe('oldest_history_boundary_reached');
    expect(crawlResult.scrollContainerTag).toBe('div');
    expect(crawlResult.initialScrollTop).toBe(-800);

    // 2. Primary candidate verification
    expect(crawlResult.crawlerCandidates).toBeDefined();
    expect(crawlResult.crawlerCandidates![0]!.probeScore).toBe(9999);
    expect(crawlResult.crawlerCandidates![0]!.probeResult).toContain('primary [data-app-action-timeline-scroll]');

    // 3. Chronological ranking
    const expectedIds = turnsDataset.flatMap((t) => [t.userMsgId, t.asstMsgId]);
    const actualIds = crawlResult.results.map((r) => r.message.id);
    expect(actualIds).toEqual(expectedIds);

    const sequences = crawlResult.results.map((r) => r.message.sequence);
    expect(sequences).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));

    // 4. Code block preservation without copy button leak
    const turn5Asst = crawlResult.results.find((r) => r.message.id === 'msg-id-5-assistant')!;
    expect(turn5Asst).toBeDefined();
    const codePart = turn5Asst.message.content.find((p) => p.type === 'code');
    expect(codePart).toBeDefined();
    if (codePart && codePart.type === 'code') {
      expect(codePart.language).toBe('python');
      expect(codePart.code).toContain('def hello_world():');
      expect(codePart.code).not.toContain('Copy code');
    }

    // 5. Iteration log diagnostics
    expect(crawlResult.iterationLogs).toBeDefined();
    expect(crawlResult.iterationLogs!.length).toBeGreaterThan(0);
    const firstLog = crawlResult.iterationLogs![0]!;
    expect(firstLog.scrollTopBefore).toBe(-800);
    expect(firstLog.requestedScrollTop).toBeLessThan(-800);

    // 6. Sanitized diagnostics: no conversation text in candidate logs or iteration logs
    const serializedDiag = JSON.stringify({
      candidates: crawlResult.crawlerCandidates,
      iterations: crawlResult.iterationLogs,
    });
    expect(serializedDiag).not.toContain('User question for turn');
    expect(serializedDiag).not.toContain('Assistant response for turn');
    expect(serializedDiag).not.toContain('def hello_world');
  });

  it('persists diagnostics to browser.storage.local on capture completion and supports recovery', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div
        data-app-action-timeline-scroll="true"
        style="display: flex; flex-direction: column-reverse; height: 600px; overflow-y: auto;"
      >
        <div data-turn-key="turn-uuid-0">
          <div data-content-search-turn-key="fallback-turn-0">
            <div data-content-search-unit-key="fallback-turn-0:0:user" data-chatgpt-selection-message-id="msg-u0">
              <p>Hello world</p>
            </div>
          </div>
        </div>
      </div>
    `;

    const storageMap = new Map<string, any>();
    (globalThis as any).browser = {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            if (typeof keys === 'string') {
              return { [keys]: storageMap.get(keys) };
            }
            const res: Record<string, any> = {};
            for (const k of keys) {
              if (storageMap.has(k)) res[k] = storageMap.get(k);
            }
            return res;
          },
          set: async (items: Record<string, any>) => {
            for (const [k, v] of Object.entries(items)) {
              storageMap.set(k, v);
            }
          },
        },
      },
    };

    const adapter = new ChatGPTAdapter();

    // Verify authoritative pre-crawl diagnostics: [data-app-action-timeline-scroll] is given 9999
    const preCrawlDiag = await adapter.getDiagnostics(doc as unknown as Document);
    expect(preCrawlDiag.crawlerCandidates).toBeDefined();
    expect(preCrawlDiag.crawlerCandidates![0]!.probeScore).toBe(9999);
    expect(preCrawlDiag.crawlerCandidates![0]!.probeResult).toContain('primary [data-app-action-timeline-scroll]');

    const progressReports: any[] = [];
    const result = await adapter.captureConversation(
      { maxScrollAttempts: 5, scrollDelayMs: 10 },
      (p) => progressReports.push(p),
      undefined,
      doc as unknown as Document
    );

    expect(progressReports.length).toBeGreaterThan(0);
    expect(result.snapshot.messages).toHaveLength(1);
    expect(storageMap.has('lastChatGPTDiagnostics')).toBe(true);
    expect(storageMap.has('lastChatGPTCrawlStats')).toBe(true);

    const storedDiag = storageMap.get('lastChatGPTDiagnostics');
    expect(storedDiag.adapterId).toBe('chatgpt');
    expect(storedDiag.crawlerCandidates).toBeDefined();

    // Verify direct leaf store reading
    const storePayload = await loadLastChatGPTDiagnostics();
    expect(storePayload?.diagnostics?.adapterId).toBe('chatgpt');

    // Verify fresh adapter instance can recover diagnostics from storage
    const freshAdapter = new ChatGPTAdapter();
    const recoveredDiag = await freshAdapter.getDiagnostics(doc as unknown as Document);
    expect(recoveredDiag.capturedMessageCount).toBe(1);
    expect(recoveredDiag.crawlerCandidates).toBeDefined();

    delete (globalThis as any).browser;
  });

  it('stitches virtual windows when fallback-turn-N is completely renumbered on every window and user messages have stable IDs (Bug 2 fix)', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div
        data-app-action-timeline-scroll="true"
        style="display: flex; flex-direction: column-reverse; height: 600px; overflow-y: auto;"
      >
        <div id="timeline-container"></div>
      </div>
    `;

    const container = doc.querySelector('[data-app-action-timeline-scroll]') as unknown as HTMLElement;
    const timeline = doc.querySelector('#timeline-container') as unknown as HTMLElement;

    // Six logical turns: A, B, C, D, E, F
    // User messages do NOT have provider message IDs (simulating real ChatGPT DOM)
    // Assistant messages have stable provider message IDs
    const allTurns = [
      { id: 'uuid-A', userText: 'User A: первое сообщение...', asstText: 'Asst A', asstId: 'msg-asst-A' },
      { id: 'uuid-B', userText: 'User B', asstText: 'Asst B', asstId: 'msg-asst-B' },
      { id: 'uuid-C', userText: 'User C', asstText: 'Asst C', asstId: 'msg-asst-C' },
      { id: 'uuid-D', userText: 'User D', asstText: 'Asst D', asstId: 'msg-asst-D' },
      { id: 'uuid-E', userText: 'User E', asstText: 'Asst E', asstId: 'msg-asst-E' },
      { id: 'uuid-F', userText: 'User F', asstText: 'Asst F', asstId: 'msg-asst-F' },
    ];

    // Window 1 (initial, newest): [D, E, F] with fallback-turn-0, 1, 2
    // Window 2 (scrolled older): [B, C, D] with fallback-turn-0, 1, 2 (D is renumbered from 0 to 2!)
    // Window 3 (oldest): [A, B, C] with fallback-turn-0, 1, 2 (B and C renumbered!)
    let currentWindow = 1;

    function renderWindow() {
      timeline.innerHTML = '';
      let visible: typeof allTurns;
      if (currentWindow === 1) {
        visible = allTurns.slice(3, 6); // D, E, F
      } else if (currentWindow === 2) {
        visible = allTurns.slice(1, 4); // B, C, D
      } else {
        visible = allTurns.slice(0, 3); // A, B, C
      }

      visible.forEach((t, localIdx) => {
        const turnDiv = doc.createElement('div');
        turnDiv.setAttribute('data-turn-key', t.id);
        // Local fallback-turn-N is completely renumbered 0, 1, 2 in EVERY window
        const localFallbackTurn = `fallback-turn-${localIdx}`;
        turnDiv.innerHTML = `
          <div data-content-search-turn-key="${localFallbackTurn}">
            <div
              data-content-search-unit-key="${localFallbackTurn}:0:user"
              data-chatgpt-search-unit-key="${localFallbackTurn}:0:user"
            >
              <div data-chatgpt-selection-conversation-id="test-conv">
                <p>${t.userText}</p>
              </div>
            </div>
            <div
              data-content-search-unit-key="${localFallbackTurn}:2:assistant"
              data-chatgpt-search-unit-key="${localFallbackTurn}:2:assistant"
              data-chatgpt-search-message-ids="${t.asstId}"
            >
              <div
                data-chatgpt-selection-conversation-id="test-conv"
                data-chatgpt-selection-message-id="${t.asstId}"
              >
                <div data-markdown-text-style="assistant-message">
                  <p>${t.asstText}</p>
                </div>
              </div>
            </div>
          </div>
        `;
        timeline.appendChild(turnDiv as unknown as Node);
      });
    }

    renderWindow();

    let scrollPos = 0; // 0 is bottom (newest) in column-reverse
    Object.defineProperty(container, 'scrollTop', {
      get() {
        return scrollPos;
      },
      set(val: number) {
        scrollPos = Math.max(-2400, val);
        // As crawler scrolls into negative territory, advance windows
        if (scrollPos <= -800 && currentWindow === 1) {
          currentWindow = 2;
          renderWindow();
        } else if (scrollPos <= -1600 && currentWindow === 2) {
          currentWindow = 3;
          renderWindow();
        }
      },
      configurable: true,
    });

    Object.defineProperty(container, 'scrollHeight', {
      get() {
        return 12000;
      },
      configurable: true,
    });
    Object.defineProperty(container, 'clientHeight', {
      get() {
        return 600;
      },
      configurable: true,
    });

    const result = await crawlChatGPTConversation(doc as unknown as Document, {
      maxScrollAttempts: 20,
      scrollDelayMs: 10,
    });

    // 1. All 6 turns must be present: 6 user + 6 asst = 12 messages total
    expect(result.results).toHaveLength(12);

    // 2. No duplicates: verify every turn ID appears exactly once for user and once for assistant
    const userMsgIds = result.results.filter((r) => r.message.role === 'user').map((r) => r.message.id);
    expect(userMsgIds).toEqual([
      'uuid-A:user',
      'uuid-B:user',
      'uuid-C:user',
      'uuid-D:user',
      'uuid-E:user',
      'uuid-F:user',
    ]);

    // 3. User message IDs MUST NOT use volatile fallback-turn-N
    for (const uid of userMsgIds) {
      expect(uid).not.toContain('fallback-turn');
    }

    // 4. Strict chronological order from oldest (A) to newest (F)
    const expectedSequence = [
      'uuid-A:user', 'msg-asst-A',
      'uuid-B:user', 'msg-asst-B',
      'uuid-C:user', 'msg-asst-C',
      'uuid-D:user', 'msg-asst-D',
      'uuid-E:user', 'msg-asst-E',
      'uuid-F:user', 'msg-asst-F',
    ];
    const actualSequence = result.results.map((r) => r.message.id);
    expect(actualSequence).toEqual(expectedSequence);

    // 5. Sequence numbers are 1..12
    expect(result.results.map((r) => r.message.sequence)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1)
    );

    // 6. The actual first message (User A) is present!
    const firstMsg = result.results[0]!;
    const firstTextPart = firstMsg.message.content.find((p) => p.type === 'text');
    expect(firstTextPart?.type === 'text' && firstTextPart.text).toContain('первое сообщение...');
  });

  it('does NOT classify normal hyperlinks or console source links as attachments while preserving real PNG uploads (Bug 3 fix)', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div data-app-action-timeline-scroll="true" style="display: flex; flex-direction: column-reverse; height: 600px;">
        <div data-turn-key="turn-uuid-0">
          <div data-content-search-turn-key="fallback-turn-0">
            <div data-content-search-unit-key="fallback-turn-0:0:user">
              <div>
                <!-- Real valid user uploaded PNG screenshot -->
                <div data-testid="file-attachment">
                  <picture>
                    <img
                      src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
                      alt="Приложение пользователя.png"
                    />
                  </picture>
                </div>
                <!-- Normal user text containing browser console source link -->
                <p>
                  I encountered this error in the console:
                  Uncaught SyntaxError at <a href="https://chatgpt.com/cdn/assets/378650.75d1b5a78e.js">378650.75d1b5a78e.js:4:62596</a>.
                  Also check <a href="https://example.com/docs/api.json">api.json documentation</a>.
                </p>
              </div>
            </div>
            <div data-content-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-selection-message-id="asst-1">
              <div data-markdown-text-style="assistant-message">
                <p>Here is the fix for that script error.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const adapter = new ChatGPTAdapter();
    const { snapshot, blobs } = await adapter.captureConversation(
      { includeAttachments: true, maxScrollAttempts: 5, scrollDelayMs: 10 },
      undefined,
      undefined,
      doc as unknown as Document
    );

    // 1. Only ONE valid attachment should be captured: the real user PNG
    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.attachments[0]!.mimeType).toBe('image/png');
    expect(snapshot.attachments[0]!.filename).toBe('Приложение пользователя.png');
    expect(blobs.size).toBe(1);

    // 2. The JS console link and json link must NOT be captured as attachments
    const attachmentUrls = snapshot.attachments.map((a) => a.sha256);
    for (const a of snapshot.attachments) {
      expect(a.filename).not.toContain('378650.75d1b5a78e.js');
      expect(a.filename).not.toContain('api.json');
    }

    // 3. User message content must contain the text with markdown link preserved
    const userMsg = snapshot.messages.find((m) => m.role === 'user')!;
    const textPart = userMsg.content.find((p) => p.type === 'text');
    expect(textPart?.type === 'text' && textPart.text).toContain(
      '[378650.75d1b5a78e.js:4:62596](https://chatgpt.com/cdn/assets/378650.75d1b5a78e.js)'
    );
  });

  it('does not terminate prematurely when oldest boundary requires extended settling for lazy-loading (Bug 1 fix)', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div data-app-action-timeline-scroll="true" style="display: flex; flex-direction: column-reverse; height: 600px;">
        <div id="container"></div>
      </div>
    `;

    const container = doc.querySelector('[data-app-action-timeline-scroll]') as unknown as HTMLElement;
    const list = doc.querySelector('#container') as unknown as HTMLElement;

    // Initially, only turns 2 and 3 are mounted
    // When scrolled back, it stalls for 2 attempts before lazy-loading turns 0 and 1
    let lazyLoaded = false;
    let attemptsAtBoundary = 0;

    function renderTurns() {
      list.innerHTML = '';
      const turnIndices = lazyLoaded ? [0, 1, 2, 3] : [2, 3];
      for (const i of turnIndices) {
        const d = doc.createElement('div');
        d.setAttribute('data-turn-key', `turn-uuid-${i}`);
        d.innerHTML = `
          <div data-content-search-turn-key="fallback-turn-${i}">
            <div data-content-search-unit-key="fallback-turn-${i}:0:user">
              <p>${i === 0 ? 'первое сообщение, начало истории...' : 'Question ' + i}</p>
            </div>
            <div data-content-search-unit-key="fallback-turn-${i}:2:assistant" data-chatgpt-selection-message-id="asst-${i}">
              <div data-markdown-text-style="assistant-message"><p>Reply ${i}</p></div>
            </div>
          </div>
        `;
        list.appendChild(d as unknown as Node);
      }
    }

    renderTurns();

    let scrollPos = 0;
    Object.defineProperty(container, 'scrollTop', {
      get() {
        return scrollPos;
      },
      set(val: number) {
        if (!lazyLoaded) {
          // Stalls at -1000 for 2 verification cycles before server responds
          scrollPos = Math.max(-1000, val);
          attemptsAtBoundary++;
          if (attemptsAtBoundary >= 2) {
            lazyLoaded = true;
            renderTurns();
          }
        } else {
          // After lazy load, allows scrolling further back to -3000 (true beginning)
          scrollPos = Math.max(-3000, val);
        }
      },
      configurable: true,
    });

    Object.defineProperty(container, 'scrollHeight', {
      get() {
        return lazyLoaded ? 8000 : 4000;
      },
      configurable: true,
    });
    Object.defineProperty(container, 'clientHeight', {
      get() {
        return 600;
      },
      configurable: true,
    });

    const result = await crawlChatGPTConversation(doc as unknown as Document, {
      maxScrollAttempts: 25,
      scrollDelayMs: 10,
    });

    // Verification engine must have persevered past temporary stall and reached turn 0
    expect(result.results.length).toBe(8); // 4 turns * 2 messages
    expect(result.beginningReached).toBe(true);
    expect(result.results[0]!.message.id).toBe('turn-uuid-0:user');
    const firstText = result.results[0]!.message.content.find((p) => p.type === 'text');
    expect(firstText?.type === 'text' && firstText.text).toContain('первое сообщение, начало истории...');
  });

  it('follows the dynamic physical boundary stepwise as scrollHeight expands from 55000→72000→104000 during lazy-loading', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div
        data-app-action-timeline-scroll="true"
        style="display: flex; flex-direction: column-reverse; height: 1000px; overflow-y: auto;"
      >
        <div id="timeline-turns"></div>
      </div>
    `;

    const scroller = doc.querySelector('[data-app-action-timeline-scroll]') as unknown as HTMLElement;
    const turnContainer = doc.querySelector('#timeline-turns') as unknown as HTMLElement;

    // 15 total turns across 3 expansion phases:
    // Phase 1 (initial): scrollHeight=55000, turns 10-14 visible
    // Phase 2 (after first boundary jump): scrollHeight expands to 72000, turns 5-14 visible
    // Phase 3 (after second boundary jump): scrollHeight expands to 104000, turns 0-14 visible
    const allTurns = Array.from({ length: 15 }, (_, i) => ({
      turnUuid: `uuid-expand-${i}`,
      turnKey: `fallback-turn-${i}`,
      userMsgId: `expand-msg-${i}-user`,
      asstMsgId: `expand-msg-${i}-assistant`,
      userText: i === 0 ? 'самое первое сообщение разговора' : `User question ${i}`,
      asstText: `Assistant response ${i}`,
    }));

    let expansionPhase = 1;
    const clientHeight = 1000;

    function getScrollHeight(): number {
      if (expansionPhase >= 3) return 104000;
      if (expansionPhase >= 2) return 72000;
      return 55000;
    }

    function getVisibleTurns(): typeof allTurns {
      if (expansionPhase >= 3) return allTurns.slice(0, 15); // all turns
      if (expansionPhase >= 2) return allTurns.slice(5, 15); // turns 5-14
      return allTurns.slice(10, 15); // turns 10-14
    }

    function renderWindow() {
      turnContainer.innerHTML = '';
      const visible = getVisibleTurns();
      visible.forEach((t, localIdx) => {
        const d = doc.createElement('div');
        d.setAttribute('data-turn-key', t.turnUuid);
        d.innerHTML = `
          <div data-content-search-turn-key="${t.turnKey}">
            <div data-content-search-unit-key="${t.turnKey}:0:user" data-chatgpt-search-message-ids="${t.userMsgId}">
              <div data-chatgpt-selection-message-id="${t.userMsgId}">
                <p>${t.userText}</p>
              </div>
            </div>
            <div data-content-search-unit-key="${t.turnKey}:2:assistant" data-chatgpt-search-message-ids="${t.asstMsgId}">
              <div data-chatgpt-selection-message-id="${t.asstMsgId}">
                <div data-markdown-text-style="assistant-message"><p>${t.asstText}</p></div>
              </div>
            </div>
          </div>
        `;
        turnContainer.appendChild(d as unknown as Node);
      });
    }

    renderWindow();

    let scrollPos = -800; // recent position near bottom
    let jumpCountAtBoundary = 0;

    Object.defineProperty(scroller, 'scrollTop', {
      get() {
        return scrollPos;
      },
      set(val: number) {
        const sh = getScrollHeight();
        const physicalBoundary = -(sh - clientHeight);

        // Clamp to current physical boundary
        scrollPos = Math.max(physicalBoundary, val);

        // If crawler jumped near or at the boundary, count it
        if (scrollPos <= physicalBoundary + 200) {
          jumpCountAtBoundary++;
          // After 1 jump at boundary in phase 1, expand to phase 2
          if (expansionPhase === 1 && jumpCountAtBoundary >= 1) {
            expansionPhase = 2;
            jumpCountAtBoundary = 0;
            renderWindow();
          }
          // After 1 jump at boundary in phase 2, expand to phase 3
          else if (expansionPhase === 2 && jumpCountAtBoundary >= 1) {
            expansionPhase = 3;
            jumpCountAtBoundary = 0;
            renderWindow();
          }
          // Phase 3: no more expansion, boundary is final
        }
      },
      configurable: true,
    });

    Object.defineProperty(scroller, 'scrollHeight', {
      get() {
        return getScrollHeight();
      },
      configurable: true,
    });

    Object.defineProperty(scroller, 'clientHeight', {
      get() {
        return clientHeight;
      },
      configurable: true,
    });

    // Stepwise traversal (≤0.8 viewport per cycle) needs ~scrollHeight / 800 cycles here.
    const result = await crawlChatGPTConversation(doc as unknown as Document, {
      maxScrollAttempts: 400,
      scrollDelayMs: 10,
    });

    // 1. All 15 turns captured: 15 user + 15 assistant = 30 messages
    expect(result.results).toHaveLength(30);

    // 2. Beginning was reached
    expect(result.beginningReached).toBe(true);
    expect(result.terminationReason).toBe('oldest_history_boundary_reached');

    // 3. First message is the real conversation beginning
    const firstMsg = result.results[0]!;
    const firstText = firstMsg.message.content.find((p) => p.type === 'text');
    expect(firstText?.type === 'text' && firstText.text).toContain('самое первое сообщение разговора');

    // 4. Correct chronological order: all user IDs followed by their assistant counterpart
    const expectedIds = allTurns.flatMap((t) => [t.userMsgId, t.asstMsgId]);
    const actualIds = result.results.map((r) => r.message.id);
    expect(actualIds).toEqual(expectedIds);

    // 5. Sequence numbers 1..30
    expect(result.results.map((r) => r.message.sequence)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1)
    );

    // 6. finalScrollHeight should reflect the expanded state
    expect(result.finalScrollHeight).toBe(104000);

    // 7. Did NOT hit max_scroll_attempts_reached
    expect(result.terminationReason).not.toBe('max_scroll_attempts_reached');

    // 8. No step skipped more than 0.8 viewport: ChatGPT virtualizes the thread (live DOM mounted
    //    3 of 34 turns in a 21 218 px scroller), so jumping straight to the edge would never
    //    mount the turns in between.
    for (const log of result.iterationLogs!) {
      expect(Math.abs(log.requestedScrollTop - log.scrollTopBefore)).toBeLessThanOrEqual(clientHeight * 0.8 + 1);
    }
    expect(result.scrollAttempts).toBeLessThan(400);
  });

  it('accepts boundary despite continuous unrelated DOM mutations when no content progress occurs', async () => {
    const window = new Window();
    const doc = window.document;

    // Short conversation — only 2 turns, already at beginning
    // But the DOM continuously produces unrelated mutations (animations, tooltips, etc.)
    doc.body.innerHTML = `
      <div
        data-app-action-timeline-scroll="true"
        style="display: flex; flex-direction: column-reverse; height: 600px; overflow-y: auto;"
      >
        <div data-turn-key="uuid-only-0">
          <div data-content-search-turn-key="fallback-turn-0">
            <div data-content-search-unit-key="fallback-turn-0:0:user" data-chatgpt-selection-message-id="msg-u0">
              <p>First user message</p>
            </div>
            <div data-content-search-unit-key="fallback-turn-0:2:assistant" data-chatgpt-selection-message-id="msg-a0">
              <div data-markdown-text-style="assistant-message"><p>First assistant reply</p></div>
            </div>
          </div>
        </div>
        <div data-turn-key="uuid-only-1">
          <div data-content-search-turn-key="fallback-turn-1">
            <div data-content-search-unit-key="fallback-turn-1:0:user" data-chatgpt-selection-message-id="msg-u1">
              <p>Second user message</p>
            </div>
            <div data-content-search-unit-key="fallback-turn-1:2:assistant" data-chatgpt-selection-message-id="msg-a1">
              <div data-markdown-text-style="assistant-message"><p>Second assistant reply</p></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const scroller = doc.querySelector('[data-app-action-timeline-scroll]') as unknown as HTMLElement;

    // Scroller is already at the oldest boundary — scrollTop clamped to -400
    let scrollPos = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      get() {
        return scrollPos;
      },
      set(val: number) {
        // Already at oldest boundary; can't go further negative than -400
        scrollPos = Math.max(-400, val);
      },
      configurable: true,
    });

    Object.defineProperty(scroller, 'scrollHeight', {
      get() {
        return 1000; // fixed — no lazy-loading expansion
      },
      configurable: true,
    });
    Object.defineProperty(scroller, 'clientHeight', {
      get() {
        return 600;
      },
      configurable: true,
    });

    const result = await crawlChatGPTConversation(doc as unknown as Document, {
      maxScrollAttempts: 20,
      scrollDelayMs: 10,
    });

    // 1. All 4 messages captured
    expect(result.results).toHaveLength(4);

    // 2. Boundary was reached — unrelated DOM mutations did NOT block detection
    expect(result.beginningReached).toBe(true);
    expect(result.terminationReason).toBe('oldest_history_boundary_reached');

    // 3. Should have used few iterations (boundary detected quickly)
    expect(result.scrollAttempts).toBeLessThan(12);
  });

  it('orders image-only user unit BEFORE assistant response within the same turn (Bug 2 fix)', async () => {
    const window = new Window();
    const doc = window.document;

    // Simulate turn 00000000-0000-4000-8000-000000000004
    // user unit index 0 -> image only
    // assistant unit index 2 -> text
    doc.body.innerHTML = `
      <div data-app-action-timeline-scroll="true" style="display: flex; flex-direction: column-reverse; height: 600px;">
        <div data-turn-key="00000000-0000-4000-8000-000000000004">
          <div data-content-search-turn-key="fallback-turn-4">
            <!-- User unit index 0: image only -->
            <div data-content-search-unit-key="fallback-turn-4:0:user">
              <div>
                <div data-testid="file-attachment">
                  <picture>
                    <img
                      src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
                      alt="Приложение пользователя.png"
                    />
                  </picture>
                </div>
              </div>
            </div>
            <!-- Assistant unit index 2: text -->
            <div data-content-search-unit-key="fallback-turn-4:2:assistant" data-chatgpt-selection-message-id="asst-turn-4">
              <div data-markdown-text-style="assistant-message">
                <p>Я вижу ваш скриншот. Вот ответ на вопрос.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const adapter = new ChatGPTAdapter();
    const { snapshot, blobs } = await adapter.captureConversation(
      { includeAttachments: true, maxScrollAttempts: 5, scrollDelayMs: 10 },
      undefined,
      undefined,
      doc as unknown as Document
    );

    // 1. Both messages must exist: user image and assistant response
    expect(snapshot.messages).toHaveLength(2);

    // 2. Strict intra-turn order: USER BEFORE ASSISTANT
    expect(snapshot.messages[0]!.role).toBe('user');
    expect(snapshot.messages[1]!.role).toBe('assistant');
    expect(snapshot.messages[0]!.sequence).toBe(1);
    expect(snapshot.messages[1]!.sequence).toBe(2);

    // 3. User message must contain the image part
    const userImgPart = snapshot.messages[0]!.content.find((p) => p.type === 'image');
    expect(userImgPart).toBeDefined();

    // 4. Assistant message must contain text
    const asstTextPart = snapshot.messages[1]!.content.find((p) => p.type === 'text');
    expect(asstTextPart?.type === 'text' && asstTextPart.text).toContain('Я вижу ваш скриншот');

    // 5. Blob store captured the PNG
    expect(blobs.size).toBe(1);
    expect(snapshot.attachments).toHaveLength(1);
  });

  it('captures file-only user turn without text as a canonical user message (Bug 1 fix)', async () => {
    const window = new Window();
    const doc = window.document;

    // Simulate turn 00000000-0000-4000-8000-000000000005
    // User has no textual content, only attachment: diagnostics.txt
    // Assistant responds normally
    doc.body.innerHTML = `
      <div data-app-action-timeline-scroll="true" style="display: flex; flex-direction: column-reverse; height: 600px;">
        <div data-turn-key="00000000-0000-4000-8000-000000000005">
          <div data-content-search-turn-key="fallback-turn-5">
            <!-- User unit: file-only upload without text -->
            <div data-content-search-unit-key="fallback-turn-5:0:user">
              <div data-testid="file-card" data-file-name="diagnostics.txt" data-file-url="data:text/plain;base64,ZGlhZ25vc3RpY3M=">
                <div class="truncate font-semibold">diagnostics.txt</div>
                <span class="text-xs">15 KB</span>
              </div>
            </div>
            <!-- Assistant unit -->
            <div data-content-search-unit-key="fallback-turn-5:2:assistant" data-chatgpt-selection-message-id="asst-turn-5">
              <div data-markdown-text-style="assistant-message">
                <p>Файл диагностики получен, анализирую ошибки...</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const adapter = new ChatGPTAdapter();
    const { snapshot, blobs } = await adapter.captureConversation(
      { includeAttachments: true, maxScrollAttempts: 5, scrollDelayMs: 10 },
      undefined,
      undefined,
      doc as unknown as Document
    );

    // 1. Must produce 2 canonical messages, NOT only assistant!
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]!.role).toBe('user');
    expect(snapshot.messages[1]!.role).toBe('assistant');

    // 2. User message must contain a canonical file content part
    const filePart = snapshot.messages[0]!.content.find((p) => p.type === 'file');
    expect(filePart).toBeDefined();
    if (filePart && filePart.type === 'file') {
      expect(filePart.filename).toBe('diagnostics.txt');
      expect(filePart.mimeType).toBe('text/plain');
      expect(filePart.blobSha256).toBeDefined();
    }

    // 3. Blob and attachment created
    expect(snapshot.attachments).toHaveLength(1);
    expect(snapshot.attachments[0]!.filename).toBe('diagnostics.txt');
    expect(snapshot.attachments[0]!.mimeType).toBe('text/plain');
    expect(blobs.size).toBe(1);

    // 4. Diagnostics report 0 assistantOnlyTurns and 0 userUnitsWithNoCanonicalMessage
    const diag = await adapter.getDiagnostics(doc as unknown as Document);
    expect(diag.assistantOnlyTurns).toBe(0);
    expect(diag.userUnitsWithNoCanonicalMessage).toBe(0);
  });

  it('captures multiple uploaded file types (.txt, .pdf, .ctxbridge, .zip) from genuine ChatGPT upload cards (Bug 3 fix)', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div data-app-action-timeline-scroll="true" style="display: flex; flex-direction: column-reverse; height: 600px;">
        <div data-turn-key="turn-multi-files">
          <div data-content-search-turn-key="fallback-turn-6">
            <div data-content-search-unit-key="fallback-turn-6:0:user">
              <div>
                <p>Here are the test files for review:</p>
                <!-- File 1: .txt file card -->
                <div data-testid="file-card" data-file-name="system-info.txt" data-file-url="data:text/plain;charset=utf-8,system%20info">
                  <span class="filename">system-info.txt</span>
                </div>
                <!-- File 2: .pdf file card with download link -->
                <div class="attachment-card" data-file-id="file-pdf-123">
                  <a href="data:application/pdf;base64,JVBERi0xLjQK" download="specification.pdf">
                    specification.pdf
                  </a>
                </div>
                <!-- File 3: .ctxbridge archive card -->
                <div data-testid="user-file-upload" data-file-name="conversation-backup.ctxbridge" data-file-url="data:application/octet-stream;base64,Q1RYQlJERzE=">
                  <div class="truncate">conversation-backup.ctxbridge</div>
                </div>
                <!-- File 4: .zip archive card -->
                <div data-testid="file-attachment" data-file-name="archive.zip" data-file-url="data:application/zip;base64,UEsDBBQAAAA=">
                  <span class="title">archive.zip</span>
                </div>
              </div>
            </div>
            <div data-content-search-unit-key="fallback-turn-6:2:assistant" data-chatgpt-selection-message-id="asst-turn-6">
              <div data-markdown-text-style="assistant-message">
                <p>Все 4 файла получены и проверены.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const adapter = new ChatGPTAdapter();
    const { snapshot, blobs } = await adapter.captureConversation(
      { includeAttachments: true, maxScrollAttempts: 5, scrollDelayMs: 10 },
      undefined,
      undefined,
      doc as unknown as Document
    );

    // 1. Two messages: user and assistant
    expect(snapshot.messages).toHaveLength(2);
    const userMsg = snapshot.messages[0]!;
    expect(userMsg.role).toBe('user');

    // 2. Exactly 4 file parts in user message
    const fileParts = userMsg.content.filter((p) => p.type === 'file');
    expect(fileParts).toHaveLength(4);

    const filenames = fileParts.map((f) => (f.type === 'file' ? f.filename : ''));
    expect(filenames).toContain('system-info.txt');
    expect(filenames).toContain('specification.pdf');
    expect(filenames).toContain('conversation-backup.ctxbridge');
    expect(filenames).toContain('archive.zip');

    // 3. Inferred mime types
    const pdfPart = fileParts.find((f) => f.type === 'file' && f.filename === 'specification.pdf');
    expect(pdfPart?.type === 'file' && pdfPart.mimeType).toBe('application/pdf');

    const txtPart = fileParts.find((f) => f.type === 'file' && f.filename === 'system-info.txt');
    expect(txtPart?.type === 'file' && txtPart.mimeType).toBe('text/plain');

    // 4. Blobs and attachments captured for all 4 files
    expect(snapshot.attachments).toHaveLength(4);
    expect(blobs.size).toBe(4);
  });

  it('fails closed with unresolved_user_attachment when user file bytes cannot be resolved and reports structural candidates', async () => {
    const window = new Window();
    const doc = window.document;

    // Simulate turn with *(Attachment)* placeholder and unresolvable file card
    doc.body.innerHTML = `
      <div data-app-action-timeline-scroll="true" style="display: flex; flex-direction: column-reverse; height: 600px;">
        <div data-turn-key="turn-unresolved-file">
          <div data-content-search-turn-key="fallback-turn-8">
            <div data-content-search-unit-key="fallback-turn-8:0:user">
              <div>
                <p>*(Attachment)*</p>
                <div class="unsupported-file-wrapper" data-file-ref="unsupported-123">
                  <span>unsupported-file.bin</span>
                </div>
              </div>
            </div>
            <div data-content-search-unit-key="fallback-turn-8:2:assistant">
              <div data-markdown-text-style="assistant-message">
                <p>Received your file.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const adapter = new ChatGPTAdapter();
    let thrownError: any = null;
    try {
      await adapter.captureConversation(
        { includeAttachments: true, maxScrollAttempts: 5, scrollDelayMs: 10 },
        undefined,
        undefined,
        doc as unknown as Document
      );
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(CaptureIncompleteError);
    expect(thrownError?.details?.terminationReason).toBe('unresolved_user_attachment');
    expect(thrownError?.details?.attachmentSentinelUnits).toBeGreaterThanOrEqual(1);
    expect(thrownError?.details?.unresolvedAttachmentOnlyUnits).toBeGreaterThanOrEqual(1);
    expect(thrownError?.details?.fileCardCandidatesObserved?.length).toBeGreaterThan(0);

    const diag = await adapter.getDiagnostics(doc as unknown as Document);
    expect(diag.unresolvedAttachmentOnlyUnits).toBeGreaterThanOrEqual(1);
    expect(diag.fileCardCandidatesObserved?.length).toBeGreaterThan(0);
  });

  it('preserves source hyperlinks as normal text links and does NOT convert them to attachments (source hyperlink test)', async () => {
    const window = new Window();
    const doc = window.document;

    doc.body.innerHTML = `
      <div data-app-action-timeline-scroll="true" style="display: flex; flex-direction: column-reverse; height: 600px;">
        <div data-turn-key="turn-link-test">
          <div data-content-search-turn-key="fallback-turn-7">
            <div data-content-search-unit-key="fallback-turn-7:0:user">
              <div>
                <p>
                  Look at this CDN bundle:
                  <a href="https://chatgpt.com/cdn/assets/app.js">https://chatgpt.com/cdn/assets/app.js</a>
                  and check out documentation at
                  <a href="https://example.com/api.json">API Reference</a>.
                </p>
              </div>
            </div>
            <div data-content-search-unit-key="fallback-turn-7:2:assistant" data-chatgpt-selection-message-id="asst-turn-7">
              <div data-markdown-text-style="assistant-message">
                <p>Got it, reviewing the link.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const adapter = new ChatGPTAdapter();
    const { snapshot, blobs } = await adapter.captureConversation(
      { includeAttachments: true, maxScrollAttempts: 5, scrollDelayMs: 10 },
      undefined,
      undefined,
      doc as unknown as Document
    );

    // 1. Zero attachments captured (no false positives for CDN .js or API doc links)
    expect(snapshot.attachments).toHaveLength(0);
    expect(blobs.size).toBe(0);

    // 2. Both messages exist
    expect(snapshot.messages).toHaveLength(2);

    // 3. User message preserves the links as normal markdown text
    const userMsg = snapshot.messages[0]!;
    const textPart = userMsg.content.find((p) => p.type === 'text');
    expect(textPart?.type === 'text').toBe(true);
    if (textPart && textPart.type === 'text') {
      expect(textPart.text).toContain('[https://chatgpt.com/cdn/assets/app.js](https://chatgpt.com/cdn/assets/app.js)');
      expect(textPart.text).toContain('[API Reference](https://example.com/api.json)');
    }
  });
});


