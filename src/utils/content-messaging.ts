/**
 * Shared runtime-message handling for the provider content scripts.
 * Every async branch always answers (success or error), so the popup/background never hang.
 *
 * Captures and insertions belong to the tab, not to the popup:
 * - a finished capture goes straight into the tray (via the background), so closing the popup
 *   mid-capture loses nothing, and a reopened popup reads the state from GET_PAGE_STATUS;
 * - insertions report their outcome in the page itself (page notice) and to the background.
 */

import type { ChatAdapter, ImportResult } from '../adapters/adapter';
import type { PlatformId } from '../core/model/canonical';
import type { PreparedHandoff } from '../core/handoff/strategies';
import { fromWireHandoff } from '../core/handoff/wire-handoff';
import { platformName } from '../core/platforms';
import { encodeTrayBlobs } from '../storage/tray-store';
import {
  TRAY_SAVE_PORT,
  type CaptureStateInfo,
  type ClaimPendingHandoffResponse,
  type ExtensionMessage,
  type InjectHandoffMessage,
  type StartCaptureMessage,
  type TraySaveCapturePayload,
  type TraySaveResponse,
} from './messaging';
import { showPageNotice, type PageNoticeOptions } from './page-notice';
import { describeFiles } from './attach-report';

export interface ContentMessagingOptions {
  platformId: PlatformId;
  /** Cheap count of visible turns/messages for the popup status card. */
  countVisibleMessages: () => number;
  /** Look for a waiting "start a new chat" delivery when the page loads (default true). */
  claimPendingHandoff?: boolean;
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

/** File names a fail-closed capture error reports (CaptureIncompleteError details). */
function missingFilesOf(err: unknown): string[] | undefined {
  const list = (err as { details?: { missingFiles?: unknown } } | null)?.details?.missingFiles;
  if (!Array.isArray(list)) return undefined;
  const names = list.filter((n): n is string => typeof n === 'string' && n.length > 0).slice(0, 20);
  return names.length > 0 ? names : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Plain-language outcome for the in-page notice. */
export function describeHandoffResult(
  result: ImportResult,
  handoff: PreparedHandoff,
  via: 'direct' | 'claim'
): PageNoticeOptions {
  const target = platformName(result.targetPlatform || handoff.targetPlatform);
  const meta = handoff.metadata;
  const total = meta?.sourceMessageCount ?? handoff.stats?.totalMessages ?? 0;
  const inline = meta?.inlineMessageCount ?? handoff.stats?.activePromptMessages ?? total;
  const source = platformName(meta?.sourcePlatform);
  const manual = result.manualAttachmentRequiredFiles ?? [];

  if (result.success) {
    const lines: string[] = [];
    lines.push(
      meta?.hasAttachedTranscript
        ? `The last ${plural(inline, 'message')} are in the text. The whole conversation (${plural(total, 'message')} from ${source}) is in transcript.md.`
        : `The whole conversation is in the text: ${plural(total, 'message')} from ${source}.`
    );
    lines.push(
      ...describeFiles(result, target, {
        fileLimit: meta?.fileLimit,
        unsupportedFiles: meta?.unsupportedFiles,
        archiveFiles: meta?.archiveFiles,
      })
    );
    lines.push('Nothing has been sent yet. Review it, add your question if you like, then press Send.');
    return {
      tone: manual.length > 0 ? 'warn' : 'ok',
      title: `Conversation added to the ${target} message box`,
      lines,
      autoHideMs: manual.length > 0 ? 0 : 20_000,
    };
  }

  if (result.failureReason === 'composer_not_found') {
    return {
      tone: 'error',
      title: `Could not find the ${target} message box`,
      lines: [
        via === 'claim'
          ? 'Sign in or open a chat, then reload this page. ContextBridge tries again for a few minutes.'
          : 'Open a chat on this page, then press Paste into this chat in the ContextBridge menu again.',
      ],
      autoHideMs: 0,
    };
  }

  if (result.failureReason === 'text_not_verified') {
    return {
      tone: 'warn',
      title: 'Check the message box',
      lines: [
        'ContextBridge could not confirm that the text arrived.',
        'If the box is empty, open the ContextBridge menu, press Copy as text and paste it here.',
      ],
      autoHideMs: 0,
    };
  }

  return {
    tone: 'error',
    title: 'Could not add the conversation',
    lines: [result.message, 'Open the ContextBridge menu, press Copy as text and paste it here.'],
    autoHideMs: 0,
  };
}

/** Sends a finished capture to the background, which stores it as the tray. */
function saveCaptureToTray(payload: TraySaveCapturePayload, timeoutMs = 60_000): Promise<TraySaveResponse> {
  return new Promise((resolve) => {
    let port: ReturnType<typeof browser.runtime.connect>;
    try {
      port = browser.runtime.connect({ name: TRAY_SAVE_PORT });
    } catch (err) {
      resolve({ ok: false, error: errorText(err) });
      return;
    }
    let settled = false;
    const finish = (res: TraySaveResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {
        // already gone
      }
      resolve(res);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: 'ContextBridge did not confirm that it kept the copied chat.' }),
      timeoutMs
    );
    port.onMessage.addListener((msg: unknown) => {
      const res = msg as TraySaveResponse | undefined;
      finish(res && typeof res.ok === 'boolean' ? res : { ok: false, error: 'Unexpected answer from ContextBridge.' });
    });
    port.onDisconnect.addListener(() =>
      finish({ ok: false, error: 'ContextBridge closed the connection before the copied chat was kept.' })
    );
    try {
      port.postMessage(payload);
    } catch (err) {
      finish({ ok: false, error: errorText(err) });
    }
  });
}

/** execCommand-based insertion is most reliable once the page (not the popup) has focus. */
function waitForPageFocus(timeoutMs: number): Promise<void> {
  if (document.hasFocus()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('focus', done);
      setTimeout(resolve, 80);
    };
    const timer = setTimeout(done, timeoutMs);
    window.addEventListener('focus', done);
  });
}

export function registerContentScriptMessaging(adapter: ChatAdapter, opts: ContentMessagingOptions): void {
  let currentAbortController: AbortController | null = null;
  let captureState: CaptureStateInfo = { status: 'idle' };
  let deliveryInProgress = false;

  const broadcast = (message: ExtensionMessage) => {
    browser.runtime.sendMessage(message).catch(() => undefined);
  };

  async function safeInject(handoff: PreparedHandoff): Promise<ImportResult> {
    try {
      return await adapter.injectHandoff(handoff);
    } catch (err) {
      return {
        success: false,
        targetPlatform: opts.platformId,
        strategyUsed: handoff?.strategy ?? 'unknown',
        injectedPromptLength: 0,
        attachedFilesCount: 0,
        failureReason: 'error',
        message: `Injection failed: ${errorText(err)}`,
      };
    }
  }

  async function deliverHandoff(handoff: PreparedHandoff, via: 'direct' | 'claim'): Promise<ImportResult> {
    deliveryInProgress = true;
    try {
      await waitForPageFocus(via === 'direct' ? 2500 : 1000);
      let result = await safeInject(handoff);
      // A freshly opened chat can mount its composer late (slow start, consent screens).
      if (via === 'claim') {
        const deadline = Date.now() + 20_000;
        while (!result.success && result.failureReason === 'composer_not_found' && Date.now() < deadline) {
          await sleep(1500);
          result = await safeInject(handoff);
        }
      }
      showPageNotice(document, describeHandoffResult(result, handoff, via));
      broadcast({ type: 'HANDOFF_RESULT', via, result });
      return result;
    } finally {
      deliveryInProgress = false;
    }
  }

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const msg = message as ExtensionMessage;

    switch (msg.type) {
      case 'PING': {
        sendResponse({ ok: true, platformId: opts.platformId });
        return false;
      }

      case 'GET_PAGE_STATUS': {
        let detectedMessages = 0;
        try {
          detectedMessages = opts.countVisibleMessages();
        } catch {
          // ignore
        }
        adapter
          .getConversationMetadata()
          .then((meta) => meta.title)
          .catch(() => undefined)
          .then((title) => {
            sendResponse({
              type: 'PAGE_STATUS_RESPONSE',
              isSupported: true,
              platformId: opts.platformId,
              title,
              detectedMessages,
              pageUrl: location.href,
              capture: captureState,
            });
          });
        return true;
      }

      case 'START_CAPTURE': {
        if (currentAbortController) {
          sendResponse({ type: 'CAPTURE_ERROR', error: 'A copy is already running in this tab.' });
          return false;
        }
        const controller = new AbortController();
        currentAbortController = controller;
        const options = (msg as StartCaptureMessage).options ?? {};
        const attachmentsExcluded = options.includeAttachments === false;
        const startedAt = Date.now();
        captureState = { status: 'running', startedAt, attachmentsExcluded };

        (async () => {
          const res = await adapter.captureConversation(
            options,
            (progress) => {
              if (captureState.status === 'running') captureState = { ...captureState, progress };
              broadcast({ type: 'CAPTURE_PROGRESS', progress });
            },
            controller.signal
          );
          if (controller.signal.aborted) throw new Error('Capture cancelled by user.');
          let blobs: ReturnType<typeof encodeTrayBlobs>;
          try {
            blobs = encodeTrayBlobs(res.blobs.values());
          } catch (err) {
            // Name the step, so a failure after a complete capture is not mistaken for a crawl error.
            throw new Error(`The chat was read, but its files could not be prepared for keeping: ${errorText(err)}`);
          }
          const saved = await saveCaptureToTray({ snapshot: res.snapshot, blobs, attachmentsExcluded });
          if (!saved.ok || !saved.summary) {
            throw new Error(saved.error || 'ContextBridge could not keep the copied chat.');
          }
          return saved.summary;
        })()
          .then((summary) => {
            captureState = { status: 'done', startedAt, finishedAt: Date.now(), attachmentsExcluded };
            sendResponse({ type: 'CAPTURE_COMPLETE', summary });
            broadcast({ type: 'CAPTURE_FINISHED', platformId: opts.platformId, ok: true, summary });
          })
          .catch((err) => {
            const cancelled = controller.signal.aborted;
            const error = cancelled ? 'Capture cancelled by user.' : errorText(err);
            const missingFiles = cancelled ? undefined : missingFilesOf(err);
            if (!cancelled) console.error(`[ContextBridge] Capture error in ${opts.platformId} content script:`, err);
            captureState = {
              status: cancelled ? 'idle' : 'error',
              startedAt,
              finishedAt: Date.now(),
              error,
              cancelled,
              attachmentsExcluded,
              missingFiles,
            };
            sendResponse({ type: 'CAPTURE_ERROR', error, cancelled, missingFiles });
            broadcast({ type: 'CAPTURE_FINISHED', platformId: opts.platformId, ok: false, error, cancelled, missingFiles });
          })
          .finally(() => {
            if (currentAbortController === controller) currentAbortController = null;
          });
        return true;
      }

      case 'ABORT_CAPTURE': {
        currentAbortController?.abort();
        sendResponse({ success: true });
        return false;
      }

      case 'GET_DIAGNOSTICS': {
        adapter
          .getDiagnostics()
          .then((diagnostics) => sendResponse({ type: 'DIAGNOSTICS_RESPONSE', diagnostics }))
          .catch((err) => sendResponse({ type: 'DIAGNOSTICS_ERROR', error: errorText(err) }));
        return true;
      }

      case 'INJECT_HANDOFF': {
        const injectMsg = msg as InjectHandoffMessage;
        let handoff: PreparedHandoff;
        try {
          handoff = fromWireHandoff(injectMsg.handoff);
        } catch (err) {
          sendResponse(
            injectMsg.mode === 'background'
              ? { accepted: false, message: errorText(err) }
              : {
                  success: false,
                  targetPlatform: opts.platformId,
                  strategyUsed: 'unknown',
                  injectedPromptLength: 0,
                  attachedFilesCount: 0,
                  failureReason: 'error',
                  message: `Injection failed: ${errorText(err)}`,
                }
          );
          return false;
        }

        if (injectMsg.mode === 'background') {
          if (deliveryInProgress) {
            sendResponse({ accepted: false, message: 'ContextBridge is already adding a conversation to this chat.' });
            return false;
          }
          sendResponse({ accepted: true });
          void deliverHandoff(handoff, 'direct');
          return false;
        }

        deliverHandoff(handoff, 'direct').then((res) => sendResponse(res));
        return true;
      }

      default:
        return false;
    }
  });

  // "Start a new chat in X": the background opened this tab and waits for it to be ready.
  if (opts.claimPendingHandoff !== false) {
    void (async () => {
      try {
        const res = (await browser.runtime.sendMessage({
          type: 'CLAIM_PENDING_HANDOFF',
          platformId: opts.platformId,
        })) as ClaimPendingHandoffResponse | undefined;
        if (!res?.handoff) return;
        await deliverHandoff(fromWireHandoff(res.handoff), 'claim');
      } catch {
        // No background answer: nothing is waiting for this tab.
      }
    })();
  }
}
