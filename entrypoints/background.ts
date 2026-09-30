import {
  TRAY_SAVE_PORT,
  type ClaimPendingHandoffMessage,
  type ClaimPendingHandoffResponse,
  type ContinueInTargetMessage,
  type ContinueInTargetResponse,
  type DownloadArchiveMessage,
  type ExtensionMessage,
  type FetchMediaMessage,
  type FetchMediaResponse,
  type HandoffResultMessage,
  type LastHandoffResult,
  type ProbeInstallMainWorldMessage,
  type TraySaveCapturePayload,
  type TraySaveResponse,
} from '../src/utils/messaging';
import type { ImportResult } from '../src/adapters/adapter';
import { buildWireHandoff } from '../src/core/handoff/wire-handoff';
import { platformForUrl, platformInfo } from '../src/core/platforms';
import {
  clearDiskTray,
  decodeTrayBlobs,
  loadTrayEntry,
  loadTraySummary,
  makeTrayEntry,
  saveTray,
} from '../src/storage/tray-store';
import {
  clearPendingHandoffs,
  getPendingHandoff,
  isPendingHandoffUsable,
  removePendingHandoff,
  setPendingHandoff,
} from '../src/storage/pending-handoff-store';
import { fromWireBytes, toWireBytes } from '../src/utils/wire-bytes';
import { isUrlOnHostPatterns, MEDIA_MAX_BYTES } from '../src/utils/media-fetch';
import {
  installResourceCardProbeHooks,
  mainWorldProbeArgsList,
  MainWorldProbeInstallArgs,
} from '../src/adapters/chatgpt/probe-main-world';
import {
  installFileCaptureHooks,
  fileCaptureArgsList,
  FileCaptureInstallArgs,
} from '../src/adapters/chatgpt/file-capture-main-world';

interface SenderLike {
  id?: string;
  url?: string;
  tab?: { id?: number };
  frameId?: number;
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Popup and import page: extension pages of this add-on, never a content script. */
function isExtensionPage(sender: SenderLike): boolean {
  return typeof sender.url === 'string' && sender.url.startsWith(browser.runtime.getURL('/'));
}

export default defineBackground(() => {
  console.log('[ContextBridge] Background initialized');

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as ExtensionMessage;
    const from = sender as SenderLike;

    switch (msg.type) {
      case 'DOWNLOAD_ARCHIVE':
        handleDownload(msg as DownloadArchiveMessage)
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: errorText(err) }));
        return true;

      case 'CONTINUE_IN_TARGET':
        if (!isExtensionPage(from)) return false;
        handleContinueInTarget(msg as ContinueInTargetMessage)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ success: false, message: errorText(err) }));
        return true;

      case 'CLAIM_PENDING_HANDOFF':
        handleClaim(msg as ClaimPendingHandoffMessage, from)
          .then((res) => sendResponse(res))
          .catch(() => sendResponse({ handoff: null }));
        return true;

      case 'HANDOFF_RESULT':
        handleHandoffResult(msg as HandoffResultMessage, from)
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;

      case 'PROBE_INSTALL_MAIN_WORLD':
        handleProbeInstall(msg as ProbeInstallMainWorldMessage, from)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ ok: false, error: errorText(err) }));
        return true;

      case 'FETCH_MEDIA':
        handleFetchMedia(msg as FetchMediaMessage, from)
          .then((res) => sendResponse(res))
          .catch((err) => sendResponse({ ok: false, error: errorText(err) } satisfies FetchMediaResponse));
        return true;

      default:
        return false;
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name === TRAY_SAVE_PORT) handleTraySavePort(port);
  });

  // A copied chat must not outlive the browser session: storage.session is memory only, and the
  // on-disk fallback for large chats is removed here.
  browser.runtime.onStartup.addListener(() => {
    void clearDiskTray();
    void clearPendingHandoffs();
  });
  // No tabs.onRemoved cleanup on purpose: it would wake this event page on every tab close in
  // the browser. Pending entries expire on their own (10 minutes) and tab ids are not reused.
});

/** https host patterns this extension may reach (MV3 host_permissions, MV2 permissions). */
function hostPatterns(): string[] {
  const manifest = browser.runtime.getManifest() as { host_permissions?: string[]; permissions?: string[] };
  return [...(manifest.host_permissions ?? []), ...(manifest.permissions ?? [])].filter(
    (p): p is string => typeof p === 'string' && p.startsWith('https://')
  );
}

/**
 * Media bytes for a URL a chat page shows, when the content script cannot read them itself
 * (cross-origin without CORS). Only for supported chat tabs, only GET, only https URLs on this
 * extension's host permissions (after redirects too), and never more than MEDIA_MAX_BYTES.
 */
async function handleFetchMedia(msg: FetchMediaMessage, sender: SenderLike): Promise<FetchMediaResponse> {
  const fromChatTab = sender.tab?.id !== undefined && !!platformForUrl(sender.url);
  if (!fromChatTab) return { ok: false, error: 'not_from_chat_tab' };
  const patterns = hostPatterns();
  if (typeof msg.url !== 'string' || !isUrlOnHostPatterns(msg.url, patterns)) return { ok: false, error: 'host_not_allowed' };

  const response = await fetch(msg.url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
  if (response.url && !isUrlOnHostPatterns(response.url, patterns)) return { ok: false, error: 'host_not_allowed' };
  if (!response.ok) return { ok: false, status: response.status, error: 'http_error' };
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) return { ok: false, error: 'too_large' };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MEDIA_MAX_BYTES) return { ok: false, error: 'too_large' };
  return { ok: true, data: toWireBytes(bytes), mimeType: response.headers.get('content-type') || undefined };
}

/** Content script -> tray. Accepts only captures sent from a supported chat tab. */
function handleTraySavePort(port: ReturnType<typeof browser.runtime.connect>): void {
  const sender = (port.sender ?? {}) as SenderLike;
  const fromChatTab = sender.tab?.id !== undefined && !!platformForUrl(sender.url);

  port.onMessage.addListener((raw: unknown) => {
    void (async () => {
      let res: TraySaveResponse;
      try {
        if (!fromChatTab) throw new Error('Rejected: the capture did not come from a supported chat tab.');
        const payload = raw as TraySaveCapturePayload;
        const wellFormed =
          !!payload?.snapshot &&
          Array.isArray(payload.snapshot.messages) &&
          Array.isArray(payload.blobs) &&
          payload.blobs.every((b) => typeof b?.metadata?.sha256 === 'string' && typeof b?.data?.b64 === 'string');
        if (!wellFormed) throw new Error('The copied chat arrived malformed.');
        const entry = makeTrayEntry(payload.snapshot, payload.blobs, 'capture', {
          attachmentsExcluded: payload.attachmentsExcluded,
        });
        res = { ok: true, summary: await saveTray(entry) };
      } catch (err) {
        res = { ok: false, error: errorText(err) };
      }
      try {
        port.postMessage(res);
      } catch {
        // The tab went away; the tray is saved either way.
      }
    })();
  });
}

/**
 * Opens a new chat on the target site. The target content script claims the delivery once its
 * page is ready, so nothing here waits for the page (the popup closes when the tab opens, and
 * the event page may be suspended while the target site loads or asks the user to sign in).
 */
async function handleContinueInTarget(msg: ContinueInTargetMessage): Promise<ContinueInTargetResponse> {
  const info = platformInfo(msg.targetPlatform);
  if (!info) return { success: false, message: `Unsupported target: ${msg.targetPlatform}` };

  const summary = await loadTraySummary();
  if (!summary) return { success: false, message: 'Nothing to move yet. Copy a chat first.' };

  const tab = await browser.tabs.create({ url: info.newChatUrl, active: true });
  if (tab.id === undefined) return { success: false, message: 'Could not open a new tab.' };

  await setPendingHandoff(tab.id, {
    targetPlatform: info.id,
    includeMediaFiles: msg.options?.includeAttachments !== false,
    createdAt: Date.now(),
    attempts: 0,
  });
  return {
    success: true,
    opened: true,
    tabId: tab.id,
    message: `Opened ${info.name}. The conversation goes into the message box when the page is ready.`,
  };
}

async function handleClaim(
  msg: ClaimPendingHandoffMessage,
  sender: SenderLike
): Promise<ClaimPendingHandoffResponse> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { handoff: null };

  let pending = await getPendingHandoff(tabId);
  if (!pending) {
    // The content script can in theory ask before the new tab's entry is written.
    await sleep(400);
    pending = await getPendingHandoff(tabId);
  }
  if (!pending) return { handoff: null };
  if (!isPendingHandoffUsable(pending)) {
    await removePendingHandoff(tabId);
    return { handoff: null };
  }
  if (msg.platformId !== pending.targetPlatform || platformForUrl(sender.url)?.id !== pending.targetPlatform) {
    return { handoff: null };
  }

  const entry = await loadTrayEntry();
  if (!entry) {
    await removePendingHandoff(tabId);
    return { handoff: null };
  }

  await setPendingHandoff(tabId, { ...pending, attempts: pending.attempts + 1 });
  const { blobMap, base64ByBytes } = decodeTrayBlobs(entry);
  const handoff = buildWireHandoff(
    entry.snapshot,
    blobMap,
    pending.targetPlatform,
    { includeMediaFiles: pending.includeMediaFiles },
    base64ByBytes
  );
  return { handoff };
}

async function handleHandoffResult(msg: HandoffResultMessage, sender: SenderLike): Promise<void> {
  const result = msg.result;
  if (!result || typeof result.success !== 'boolean') return;
  // The page already showed the outcome; the popup repeats it only when something needs doing.
  const needsAttention = !result.success || (result.manualAttachmentRequiredFiles?.length ?? 0) > 0;
  if (needsAttention) {
    await rememberHandoffResult(result);
  } else {
    await browser.storage.local.remove('lastHandoffResult').catch(() => undefined);
  }
  const tabId = sender.tab?.id;
  // Keep a "new chat" delivery alive when the page had no composer yet (sign-in, consent):
  // the next load of that tab claims it again.
  if (tabId !== undefined && msg.via === 'claim') {
    if (result.success || result.failureReason !== 'composer_not_found') await removePendingHandoff(tabId);
  }
}

/** The popup is usually closed when an insertion finishes; it shows this the next time it opens. */
async function rememberHandoffResult(result: ImportResult): Promise<void> {
  const last: LastHandoffResult = {
    targetPlatform: result.targetPlatform,
    success: result.success,
    message: result.message,
    attachedFiles: result.attachedFiles,
    manualAttachmentRequiredFiles: result.manualAttachmentRequiredFiles,
    filesNotConfirmed: result.filesNotConfirmed,
    filesUnverified: result.filesUnverified,
    filesOverLimit: result.filesOverLimit,
    fileLimit: result.fileLimit,
    failureReason: result.failureReason,
    at: Date.now(),
  };
  try {
    await browser.storage.local.set({ lastHandoffResult: last });
  } catch {
    // ignore storage failures
  }
}

/**
 * Runs the resource-card probe hooks in the page's MAIN world of the sending tab/frame.
 * scripting.executeScript is not subject to the page CSP (inline <script> injection is).
 */
async function handleProbeInstall(
  msg: ProbeInstallMainWorldMessage,
  sender: SenderLike
): Promise<{ ok: boolean; error?: string }> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false, error: 'no_sender_tab' };
  if (!browser.scripting?.executeScript) return { ok: false, error: 'scripting_api_unavailable' };
  const target = { tabId, frameIds: [sender.frameId ?? 0] };
  // Fixed allow-list of MAIN-world installers; the message only selects one and passes data.
  if (msg.hook === 'file-capture') {
    await browser.scripting.executeScript({
      target,
      world: 'MAIN',
      func: installFileCaptureHooks,
      args: fileCaptureArgsList(msg.args as FileCaptureInstallArgs),
    });
  } else {
    await browser.scripting.executeScript({
      target,
      world: 'MAIN',
      func: installResourceCardProbeHooks,
      args: mainWorldProbeArgsList(msg.args as MainWorldProbeInstallArgs),
    });
  }
  return { ok: true };
}

/**
 * The blob URL dies with this event page. With saveAs the user can sit in the file dialog for a
 * while, so keep the page alive (extension API calls reset Firefox's idle timer) until the
 * download has started and had time to read the blob.
 */
async function handleDownload(msg: DownloadArchiveMessage): Promise<void> {
  const bytes = fromWireBytes(msg.archiveBytes);
  const blob = new Blob([bytes as BlobPart], { type: msg.mimeType || 'application/x-contextbridge' });
  const url = URL.createObjectURL(blob);
  const keepAlive = setInterval(() => {
    browser.runtime.getPlatformInfo().catch(() => undefined);
  }, 20_000);

  try {
    await browser.downloads.download({
      url,
      filename: msg.filename,
      saveAs: msg.saveAs !== false,
    });
  } finally {
    setTimeout(() => {
      URL.revokeObjectURL(url);
      clearInterval(keepAlive);
    }, 60_000);
  }
}
