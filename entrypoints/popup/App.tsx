import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureProgress } from '../../src/adapters/adapter';
import { buildArchive } from '../../src/core/archive/writer';
import { inspectArchiveHeader, readArchive } from '../../src/core/archive/reader';
import type { AdapterDiagnostics } from '../../src/core/diagnostics/diagnostics';
import { planAttachments } from '../../src/core/handoff/attachment-plan';
import { renderTranscript } from '../../src/core/handoff/renderer';
import { buildHandoff } from '../../src/core/handoff/strategies';
import { buildWireHandoff } from '../../src/core/handoff/wire-handoff';
import { ensureChronologicalOrder } from '../../src/core/model/validation';
import { PLATFORMS, platformForUrl, platformInfo, platformName, type PlatformInfo } from '../../src/core/platforms';
import { loadLastChatGPTDiagnostics } from '../../src/storage/chatgpt-diagnostics-store';
import { loadPrefs, savePrefs } from '../../src/storage/prefs-store';
import {
  clearTray,
  decodeTrayBlobs,
  loadTrayEntry,
  loadTraySummary,
  makeTrayEntry,
  onTrayChanged,
  saveTray,
  type TrayEntry,
  type TraySummary,
} from '../../src/storage/tray-store';
import type {
  CaptureFinishedMessage,
  CaptureStateInfo,
  ContinueInTargetResponse,
  InjectHandoffAck,
  LastHandoffResult,
  PageStatusResponse,
} from '../../src/utils/messaging';
import { describeFiles } from '../../src/utils/attach-report';
import { formatDateForFilename, sanitizeFilename } from '../../src/utils/sanitize';
import { toWireBytes, type WireBytes } from '../../src/utils/wire-bytes';
import { hostOfPattern } from '../../src/utils/media-fetch';
import Diagnostics from './Diagnostics';

/*
 * One component, two places:
 * - the toolbar popup (default), working on the active tab;
 * - a full tab (?view=page&from=<tabId>) for opening .ctxbridge files. Firefox closes the popup
 *   as soon as a file picker takes focus, so files cannot be opened from the popup itself.
 */
const params = new URLSearchParams(window.location.search);
const IS_PAGE = params.get('view') === 'page';
const FROM_TAB_ID = parseTabId(params.get('from'));

function parseTabId(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

type TabStatus = 'loading' | 'ready' | 'no-script' | 'no-access' | 'unsupported' | 'none';

interface ChatTab {
  id?: number;
  windowId?: number;
  status: TabStatus;
  platform?: PlatformInfo;
  /** The platform's picture and file servers Firefox has not allowed yet (host patterns). */
  missingMedia?: string[];
  title?: string;
  url?: string;
  capture?: CaptureStateInfo;
}

type Busy = 'paste' | 'open' | 'copy-text' | 'save' | 'import' | 'access' | null;

interface Feedback {
  tone: 'ok' | 'info' | 'error';
  title: string;
  detail?: string;
  technical?: string;
  retry?: boolean;
  retryWithoutFiles?: boolean;
  /** Offer "copy anyway": keep the files that worked, mark these as not included. */
  missingFiles?: string[];
  diagnostics?: boolean;
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString();
}

/** Same conversation page (ignores query and hash); home pages never match. */
function sameConversation(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    const px = x.pathname.replace(/\/+$/, '');
    const py = y.pathname.replace(/\/+$/, '');
    return x.origin === y.origin && px === py && px.split('/').filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

interface CaptureErrorInfo {
  kind: 'cancelled' | 'files' | 'history' | 'empty' | 'busy' | 'no-script' | 'other';
  title: string;
  hint?: string;
}

/** The adapters fail closed with technical messages; say what happened and what to do. */
function describeCaptureError(error: string): CaptureErrorInfo {
  if (/cancel/i.test(error)) return { kind: 'cancelled', title: 'Copy cancelled' };
  if (/file card|file bytes|upload file/i.test(error)) {
    return {
      kind: 'files',
      title: 'Some files in this chat could not be copied',
      hint:
        'ContextBridge stops rather than leave files out silently. Try again, skip the missing files ' +
        '(they are marked as not included), or copy only the text.',
    };
  }
  if (/virtual history|fully loaded|full history|not reached/i.test(error)) {
    return {
      kind: 'history',
      title: 'Could not reach the start of the conversation',
      hint: 'Keep the tab open and visible while it copies. Scrolling to the top once can help.',
    };
  }
  if (/no conversation found/i.test(error)) {
    return { kind: 'empty', title: 'No conversation on this page', hint: 'Open a chat that has messages.' };
  }
  if (/already running/i.test(error)) return { kind: 'busy', title: 'A copy is already running in this tab' };
  if (/receiving end does not exist|could not establish connection/i.test(error)) {
    return { kind: 'no-script', title: 'ContextBridge is not running in this tab', hint: 'Reload the tab and try again.' };
  }
  return { kind: 'other', title: 'Could not copy this chat', hint: 'Try again. If it keeps failing, open Details.' };
}

function copiedFeedback(summary?: TraySummary): Feedback {
  const missing = summary?.missingAttachmentCount ?? 0;
  if (missing > 0) {
    return {
      tone: 'ok',
      title: `Chat copied without ${plural(missing, 'file')}`,
      detail:
        'The text says where they were. Now open the chat where you want to continue and press Paste into this chat.',
    };
  }
  return {
    tone: 'ok',
    title: 'Chat copied',
    detail: 'Now open the chat where you want to continue and press Paste into this chat, or start a new chat below.',
  };
}

function describeTray(t: TraySummary): string {
  const counts = [plural(t.messageCount, 'message')];
  if (t.imageCount) counts.push(plural(t.imageCount, 'image'));
  if (t.fileCount) counts.push(plural(t.fileCount, 'file'));
  return `${platformName(t.sourcePlatform)} · ${counts.join(', ')}`;
}

async function inspectTab(): Promise<ChatTab> {
  let tab: { id?: number; windowId?: number; url?: string; title?: string } | undefined;
  try {
    if (IS_PAGE) {
      if (FROM_TAB_ID === undefined) return { status: 'none' };
      tab = await browser.tabs.get(FROM_TAB_ID);
    } else {
      [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    }
  } catch {
    return { status: 'none' };
  }
  if (tab?.id === undefined) return { status: 'none' };

  const base = { id: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title };
  const fromUrl = platformForUrl(tab.url);
  try {
    const res = (await browser.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATUS' })) as PageStatusResponse | undefined;
    if (res?.type === 'PAGE_STATUS_RESPONSE' && res.isSupported) {
      const platform = platformInfo(res.platformId) ?? fromUrl;
      return {
        ...base,
        status: 'ready',
        platform,
        missingMedia: platform ? await notGranted(platform.mediaOrigins) : [],
        title: res.title || undefined,
        url: res.pageUrl || tab.url,
        capture: res.capture,
      };
    }
  } catch {
    // No content script answered in this tab.
  }
  if (!fromUrl) return { ...base, status: 'unsupported' };

  let granted = true;
  try {
    granted = await browser.permissions.contains({ origins: fromUrl.origins });
  } catch {
    granted = true;
  }
  return { ...base, status: granted ? 'no-script' : 'no-access', platform: fromUrl };
}

/**
 * The host patterns Firefox has not granted. MV3 host permissions are opt-in there: allowing an
 * extension on a chat site does not allow it on the servers that site's pictures come from.
 */
async function notGranted(origins: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const origin of origins) {
    try {
      if (!(await browser.permissions.contains({ origins: [origin] }))) missing.push(origin);
    } catch {
      // Unknown: treat as granted rather than nag.
    }
  }
  return missing;
}

/** "googleusercontent.com and lh3.google.com" */
function hostList(patterns: readonly string[]): string {
  const hosts = patterns.map(hostOfPattern);
  return hosts.length <= 1 ? (hosts[0] ?? '') : `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`;
}

async function download(bytes: Uint8Array | WireBytes, filename: string, mimeType: string, saveAs = true): Promise<void> {
  const res = (await browser.runtime.sendMessage({
    type: 'DOWNLOAD_ARCHIVE',
    archiveBytes: bytes instanceof Uint8Array ? toWireBytes(bytes) : bytes,
    filename,
    mimeType,
    saveAs,
  })) as { success?: boolean; error?: string } | undefined;
  if (res && res.success === false) throw new Error(res.error || 'The download was cancelled.');
}

async function closeThisPage(): Promise<void> {
  try {
    const self = await browser.tabs.getCurrent();
    if (self?.id !== undefined) await browser.tabs.remove(self.id);
  } catch {
    window.close();
  }
}

export default function App() {
  const [tab, setTab] = useState<ChatTab>({ status: 'loading' });
  const [tray, setTray] = useState<TraySummary | null>(null);
  const [trayLoaded, setTrayLoaded] = useState(false);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [lastHandoff, setLastHandoff] = useState<LastHandoffResult | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');

  const [pendingFile, setPendingFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [diagnostics, setDiagnostics] = useState<AdapterDiagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const tabIdRef = useRef<number | undefined>(undefined);
  /** True while this popup instance waits for its own START_CAPTURE answer. */
  const ownCaptureRef = useRef(false);
  const cancelledRef = useRef(false);

  const refreshTray = useCallback(async () => {
    const summary = await loadTraySummary();
    setTray(summary);
    setTrayLoaded(true);
  }, []);

  const showCaptureError = useCallback((error: string, withFiles: boolean, missingFiles?: string[]) => {
    const info = describeCaptureError(error);
    if (info.kind === 'cancelled') {
      setFeedback({ tone: 'info', title: info.title });
      return;
    }
    setFeedback({
      tone: 'error',
      title: info.title,
      detail: info.hint,
      technical: error,
      retry: info.kind !== 'busy' && info.kind !== 'empty',
      retryWithoutFiles: withFiles && info.kind === 'files',
      missingFiles: withFiles && info.kind === 'files' ? (missingFiles ?? []) : undefined,
      diagnostics: info.kind !== 'no-script',
    });
  }, []);

  useEffect(() => {
    if (IS_PAGE) document.title = 'Open a .ctxbridge file - ContextBridge';

    loadPrefs().then((p) => setIncludeAttachments(p.includeAttachments));
    refreshTray();

    inspectTab().then((info) => {
      tabIdRef.current = info.id;
      setTab(info);
      const c = info.capture;
      if (c?.status === 'running') {
        setCapturing(true);
        setProgress(c.progress ?? null);
      } else if (c?.status === 'error' && c.error && c.finishedAt && Date.now() - c.finishedAt < 10 * 60 * 1000) {
        showCaptureError(c.error, !c.attachmentsExcluded, c.missingFiles);
      }
    });

    browser.storage.local
      .get('lastHandoffResult')
      .then((stored: Record<string, unknown>) => {
        const last = stored?.lastHandoffResult as LastHandoffResult | undefined;
        if (!last || typeof last.at !== 'number' || Date.now() - last.at > 15 * 60 * 1000) return;
        setLastHandoff(last);
        return browser.storage.local.remove('lastHandoffResult');
      })
      .catch(() => undefined);

    const onMessage = (message: unknown, sender: { tab?: { id?: number } }) => {
      const msg = message as { type?: string } | undefined;
      const senderTab = sender?.tab?.id;
      if (senderTab !== undefined && tabIdRef.current !== undefined && senderTab !== tabIdRef.current) return;
      if (msg?.type === 'CAPTURE_PROGRESS') {
        setProgress((msg as { progress: CaptureProgress }).progress);
      } else if (msg?.type === 'CAPTURE_FINISHED' && !ownCaptureRef.current) {
        // This popup was opened while a copy was already running in the tab.
        const done = msg as CaptureFinishedMessage;
        setCapturing(false);
        if (done.ok) {
          setFeedback(copiedFeedback(done.summary));
        } else if (done.error) {
          showCaptureError(done.error, true, done.missingFiles);
        }
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    const offTray = onTrayChanged(() => {
      refreshTray();
    });
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      offTray();
    };
  }, [refreshTray, showCaptureError]);

  async function requireTrayEntry(): Promise<TrayEntry> {
    const entry = await loadTrayEntry();
    if (!entry) {
      setTray(null);
      throw new Error('The copied chat is no longer available. Copy it again.');
    }
    return entry;
  }

  async function copyThisChat(withFiles: boolean = includeAttachments, allowMissingFiles = false) {
    if (tab.id === undefined || tab.status !== 'ready') return;
    cancelledRef.current = false;
    ownCaptureRef.current = true;
    setFeedback(null);
    setLastHandoff(null);
    setProgress(null);
    setCapturing(true);
    try {
      const res = (await browser.tabs.sendMessage(tab.id, {
        type: 'START_CAPTURE',
        options: { includeAttachments: withFiles, allowMissingFiles: allowMissingFiles || undefined },
      })) as { type?: string; summary?: TraySummary; error?: string; missingFiles?: string[] } | undefined;
      if (cancelledRef.current) return;
      if (res?.type === 'CAPTURE_COMPLETE' && res.summary) {
        setTray(res.summary);
        setFeedback(copiedFeedback(res.summary));
      } else {
        showCaptureError(
          res?.error || 'No answer from the page. Reload the tab and try again.',
          withFiles,
          res?.missingFiles
        );
      }
    } catch (err) {
      if (!cancelledRef.current) showCaptureError(errorText(err), withFiles);
    } finally {
      ownCaptureRef.current = false;
      setCapturing(false);
    }
  }

  async function cancelCopy() {
    cancelledRef.current = true;
    try {
      if (tab.id !== undefined) await browser.tabs.sendMessage(tab.id, { type: 'ABORT_CAPTURE' });
    } catch {
      // The tab is gone or reloading; nothing left to cancel.
    }
    setCapturing(false);
    setFeedback({ tone: 'info', title: 'Copy cancelled' });
  }

  async function pasteHere() {
    if (tab.id === undefined || tab.status !== 'ready' || !tab.platform) return;
    setBusy('paste');
    setFeedback(null);
    try {
      const entry = await requireTrayEntry();
      const { blobMap, base64ByBytes } = decodeTrayBlobs(entry);
      const handoff = buildWireHandoff(entry.snapshot, blobMap, tab.platform.id, { includeMediaFiles: true }, base64ByBytes);
      const ack = (await browser.tabs.sendMessage(tab.id, {
        type: 'INJECT_HANDOFF',
        handoff,
        mode: 'background',
      })) as InjectHandoffAck | undefined;
      if (!ack?.accepted) {
        throw new Error(ack?.message || 'The page did not take the conversation. Reload it and try again.');
      }
      // The page inserts once it has focus again and shows the result itself.
      if (IS_PAGE) {
        await browser.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
        await closeThisPage();
      } else {
        window.close();
      }
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not paste into this chat', detail: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function openNewChat(target: PlatformInfo) {
    setBusy('open');
    setFeedback(null);
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'CONTINUE_IN_TARGET',
        targetPlatform: target.id,
        options: { includeAttachments: true },
      })) as ContinueInTargetResponse | undefined;
      if (!res?.success) throw new Error(res?.message || `Could not open ${target.name}.`);
      // The popup closes by itself when the new tab opens.
      if (IS_PAGE) await closeThisPage();
    } catch (err) {
      setFeedback({ tone: 'error', title: `Could not open ${target.name}`, detail: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function copyAsText() {
    setBusy('copy-text');
    setFeedback(null);
    try {
      const entry = await requireTrayEntry();
      const { blobMap } = decodeTrayBlobs(entry);
      // Everything inline: a single paste works in any chat, including unsupported ones.
      const handoff = buildHandoff(entry.snapshot, blobMap, 'other', { strategy: 'FULL', includeMediaFiles: false });
      await navigator.clipboard.writeText(handoff.promptText);
      const hasFiles = entry.blobs.length > 0;
      setFeedback({
        tone: 'ok',
        title: 'Copied to the clipboard',
        detail:
          `${plural(handoff.promptText.length, 'character')}. Paste it into the message box of any AI chat.` +
          (hasFiles ? ' Files are not part of the text; use Save files to attach them.' : ''),
      });
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not copy the text', detail: `${errorText(err)} Use Save .md instead.` });
    } finally {
      setBusy(null);
    }
  }

  async function saveTranscript() {
    setBusy('save');
    setFeedback(null);
    try {
      const entry = await requireTrayEntry();
      const { blobMap } = decodeTrayBlobs(entry);
      const sorted = ensureChronologicalOrder(entry.snapshot);
      // Files are named as Save files names them, so the transcript and the saved files match.
      const plan = planAttachments(sorted.messages, blobMap, ['transcript.md']);
      const saved = new Set(plan.entries.filter((e) => !e.archive).map((e) => e.sha256));
      const md = renderTranscript(sorted, { blobMap, attachmentRefs: { names: plan.names, attached: saved } });
      const name = `${sanitizeFilename(entry.snapshot.title || 'conversation')}-transcript.md`;
      await download(new TextEncoder().encode(md), name, 'text/markdown;charset=utf-8');
      setFeedback({ tone: 'ok', title: 'Saved', detail: name });
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not save the transcript', detail: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function saveFiles() {
    setBusy('save');
    setFeedback(null);
    try {
      const entry = await requireTrayEntry();
      const { blobMap, base64ByBytes } = decodeTrayBlobs(entry);
      // The names the pasted text uses ("[Image: name]"), so saved files match the references.
      const plan = planAttachments(ensureChronologicalOrder(entry.snapshot).messages, blobMap, ['transcript.md']);
      let saved = 0;
      for (const file of plan.entries) {
        if (file.archive) continue;
        const b64 = base64ByBytes.get(file.data);
        await download(b64 !== undefined ? { b64 } : file.data, file.filename, file.mimeType, false);
        saved++;
      }
      setFeedback({ tone: 'ok', title: `Saved ${plural(saved, 'file')}`, detail: 'They are in your Downloads folder.' });
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not save the files', detail: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function saveArchive() {
    setBusy('save');
    setFeedback(null);
    try {
      const entry = await requireTrayEntry();
      const { blobMap } = decodeTrayBlobs(entry);
      const bytes = await buildArchive(entry.snapshot, blobMap, {
        compress: true,
        password: protect && password ? password : undefined,
      });
      const name = `${sanitizeFilename(entry.snapshot.title || 'conversation')}-${formatDateForFilename()}.ctxbridge`;
      await download(bytes, name, 'application/x-contextbridge');
      setPassword('');
      setFeedback({ tone: 'ok', title: 'Saved', detail: name });
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not save the file', detail: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function forgetTray() {
    await clearTray();
    setTray(null);
    setFeedback(null);
  }

  async function openImportPage() {
    const query = tab.id !== undefined ? `?view=page&from=${tab.id}` : '?view=page';
    try {
      await browser.tabs.create({ url: browser.runtime.getURL(`/popup.html${query}`) });
      window.close();
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not open the file page', detail: errorText(err) });
    }
  }

  async function reloadTab() {
    if (tab.id === undefined) return;
    try {
      await browser.tabs.reload(tab.id);
      window.close();
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not reload the tab', detail: errorText(err) });
    }
  }

  async function grantAccess() {
    if (!tab.platform) return;
    setBusy('access');
    try {
      // The site and the servers its pictures come from, in one prompt.
      const origins = [...tab.platform.origins, ...tab.platform.mediaOrigins];
      const granted = await browser.permissions.request({ origins });
      if (granted) {
        setTab((t) => ({ ...t, status: 'no-script', missingMedia: [] }));
        setFeedback({ tone: 'ok', title: 'Access allowed', detail: 'Reload the tab to start.' });
      }
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not ask for access', detail: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  /** Allows the picture servers; `thenCopy` repeats the copy that failed because of them. */
  async function grantMediaAccess(thenCopy: boolean) {
    const origins = tab.missingMedia ?? [];
    if (origins.length === 0) return;
    setBusy('access');
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins });
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not ask for access', detail: errorText(err) });
    } finally {
      setBusy(null);
    }
    if (!granted) return;
    setTab((t) => ({ ...t, missingMedia: [] }));
    if (thenCopy) {
      await copyThisChat(true);
    } else {
      setFeedback({ tone: 'ok', title: 'Pictures allowed', detail: 'Pictures and files are copied with the chat now.' });
    }
  }

  async function openDiagnostics() {
    let found: AdapterDiagnostics | null = null;
    try {
      if (tab.id !== undefined && tab.status === 'ready') {
        const res = (await browser.tabs.sendMessage(tab.id, { type: 'GET_DIAGNOSTICS' })) as
          | { diagnostics?: AdapterDiagnostics }
          | undefined;
        found = res?.diagnostics ?? null;
      }
    } catch {
      // fall back to the stored report
    }
    if (!found) {
      const stored = await loadLastChatGPTDiagnostics();
      found = stored?.diagnostics ?? null;
    }
    if (found) {
      setDiagnostics(found);
      setShowDiagnostics(true);
    } else {
      setFeedback({ tone: 'info', title: 'No diagnostics yet', detail: 'They appear after a copy attempt on a chat page.' });
    }
  }

  async function openArchive(name: string, bytes: Uint8Array, pw?: string) {
    const result = await readArchive(bytes, pw ? { password: pw } : {});
    const summary = await saveTray(makeTrayEntry(result.snapshot, result.blobs.values(), 'file', { fileName: name }));
    setTray(summary);
    setPendingFile(null);
    setImportPassword('');
    setFeedback({
      tone: 'ok',
      title: `Opened ${name}`,
      detail:
        tab.status === 'ready' && tab.platform
          ? `Press Paste into ${tab.platform.name} chat to continue in the tab you came from.`
          : 'Start a new chat below, or copy it as text for any other AI.',
    });
  }

  async function loadArchiveFile(file: File) {
    setFeedback(null);
    setBusy('import');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let encrypted = false;
      try {
        encrypted = inspectArchiveHeader(bytes).isEncrypted;
      } catch {
        throw new Error(`${file.name} is not a ContextBridge file.`);
      }
      if (encrypted) {
        setPendingFile({ name: file.name, bytes });
        return;
      }
      await openArchive(file.name, bytes);
    } catch (err) {
      setFeedback({ tone: 'error', title: 'Could not open the file', detail: errorText(err) });
    } finally {
      setBusy(null);
    }
  }

  async function submitImportPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pendingFile || !importPassword) return;
    setBusy('import');
    setFeedback(null);
    try {
      await openArchive(pendingFile.name, pendingFile.bytes, importPassword);
    } catch (err) {
      const wrong = (err as { code?: string })?.code === 'WRONG_PASSWORD';
      setFeedback({
        tone: 'error',
        title: wrong ? 'Wrong password' : 'Could not open the file',
        detail: wrong ? 'Check the password and try again.' : errorText(err),
      });
    } finally {
      setBusy(null);
    }
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) loadArchiveFile(file);
  }

  // Page mode: a file dropped anywhere on the page is opened (instead of Firefox navigating to it).
  const loadFileRef = useRef<(file: File) => void>(() => undefined);
  useEffect(() => {
    loadFileRef.current = loadArchiveFile;
  });
  useEffect(() => {
    if (!IS_PAGE) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragEnd = () => setDragOver(false);
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) loadFileRef.current(file);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragEnd);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragEnd);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  function toggleAttachments(value: boolean) {
    setIncludeAttachments(value);
    savePrefs({ includeAttachments: value });
  }

  const sameChat = !!tray && tab.status === 'ready' && sameConversation(tray.sourceUrl, tab.url);
  const canPaste = !!tray && tab.status === 'ready' && !!tab.platform && !sameChat && !capturing;
  const trayFirst = IS_PAGE || canPaste || (!!tray && tab.status !== 'ready' && tab.status !== 'loading');
  const locked = capturing || busy !== null;

  const tabSection = IS_PAGE ? null : (
    <TabSection
      tab={tab}
      tray={tray}
      sameChat={sameChat}
      capturing={capturing}
      progress={progress}
      locked={locked}
      includeAttachments={includeAttachments}
      onToggleAttachments={toggleAttachments}
      onCopy={() => copyThisChat()}
      onCancel={cancelCopy}
      onReload={reloadTab}
      onGrant={grantAccess}
      onGrantMedia={() => grantMediaAccess(false)}
    />
  );

  const traySection = !trayLoaded ? (
    <section className="panel" aria-busy="true">
      <Skeleton />
    </section>
  ) : tray ? (
    <section className="panel" aria-labelledby="tray-heading">
      <div className="row">
        <h2 id="tray-heading" className="label">
          Copied chat
        </h2>
        <button type="button" className="link" onClick={forgetTray} disabled={locked}>
          Clear
        </button>
      </div>
      <p className="name">{tray.title}</p>
      <p className="meta">{describeTray(tray)}</p>
      <p className="meta">
        {tray.origin === 'file' ? `Opened from ${tray.fileName || 'a file'}` : 'Copied'} {timeAgo(tray.savedAt)}
        {tray.attachmentsExcluded ? ', without files' : ''}
        {!tray.attachmentsExcluded && tray.missingAttachmentCount
          ? `, ${plural(tray.missingAttachmentCount, 'file')} not included`
          : ''}
      </p>

      {canPaste && tab.platform && (
        <div className="stack-sm">
          <button type="button" className="btn primary wide" onClick={pasteHere} disabled={locked}>
            {busy === 'paste' ? 'Pasting...' : IS_PAGE ? `Paste into ${tab.platform.name} chat` : 'Paste into this chat'}
          </button>
          <p className="hint">It goes into the message box. Nothing is sent until you press Send.</p>
        </div>
      )}
      {sameChat && (
        <p className="hint">This is the chat you copied. Open the chat where you want to continue, or start a new one.</p>
      )}

      <div className="group">
        <h3 className="sublabel">Start a new chat in</h3>
        <div className="choice">
          {PLATFORMS.map((p) => (
            <button key={p.id} type="button" className="btn" onClick={() => openNewChat(p)} disabled={locked}>
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="group">
        <h3 className="sublabel">Any other AI</h3>
        <div className="choice">
          <button type="button" className="btn" onClick={copyAsText} disabled={locked}>
            {busy === 'copy-text' ? 'Copying...' : 'Copy as text'}
          </button>
          <button type="button" className="btn" onClick={saveTranscript} disabled={locked}>
            Save .md
          </button>
          {tray.imageCount + tray.fileCount > 0 && (
            <button type="button" className="btn" onClick={saveFiles} disabled={locked}>
              Save files
            </button>
          )}
        </div>
      </div>

      <details className="more">
        <summary>Save as .ctxbridge file</summary>
        <div className="stack-sm">
          <p className="hint">A complete copy with files, to keep or to open later with Open .ctxbridge file.</p>
          <label className="check">
            <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
            <span>Protect with a password</span>
          </label>
          {protect && (
            <div className="field">
              <label htmlFor="archive-password">Password</label>
              <input
                id="archive-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="hint">You need it to open the file. ContextBridge does not keep it.</p>
            </div>
          )}
          <button
            type="button"
            className="btn wide"
            onClick={saveArchive}
            disabled={locked || (protect && !password)}
          >
            Save .ctxbridge
          </button>
        </div>
      </details>

      {tray.area === 'local' && (
        <p className="hint">Large chat: kept on disk until Firefox restarts or you press Clear.</p>
      )}
    </section>
  ) : (
    <section className="panel quiet" aria-labelledby="empty-heading">
      <h2 id="empty-heading" className="label">
        Copied chat
      </h2>
      <p className="body">Nothing copied yet. Moving a chat takes three steps:</p>
      <HowItWorks />
    </section>
  );

  const importSection = IS_PAGE ? (
    <section className="panel" aria-labelledby="import-heading">
      <h2 id="import-heading" className="label">
        Open a .ctxbridge file
      </h2>
      {pendingFile ? (
        <form className="stack-sm" onSubmit={submitImportPassword}>
          <p className="body">{pendingFile.name} is protected with a password.</p>
          <div className="field">
            <label htmlFor="import-password">Password</label>
            <input
              id="import-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={importPassword}
              onChange={(e) => setImportPassword(e.target.value)}
            />
          </div>
          <div className="row end">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPendingFile(null);
                setImportPassword('');
              }}
              disabled={busy === 'import'}
            >
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!importPassword || busy === 'import'}>
              {busy === 'import' ? 'Opening...' : 'Open'}
            </button>
          </div>
        </form>
      ) : (
        <label className={`drop${dragOver ? ' over' : ''}`}>
          <input type="file" accept=".ctxbridge" className="file-input" onChange={onPickFile} disabled={busy === 'import'} />
          <span className="drop-main">{busy === 'import' ? 'Opening...' : 'Drop the file here'}</span>
          <span className="drop-sub">or click to choose it</span>
        </label>
      )}
      {tab.status === 'ready' && tab.platform ? (
        <p className="hint">
          Then paste it into the {tab.platform.name} tab you came from{tab.title ? ` (${tab.title})` : ''}.
        </p>
      ) : (
        <p className="hint">Then start a new chat, or copy it as text for any AI.</p>
      )}
    </section>
  ) : null;

  return (
    <div className={`app${IS_PAGE ? ' page' : ''}${showDiagnostics && !IS_PAGE ? ' tall' : ''}`}>
      <header className="top">
        <span className="wordmark">ContextBridge</span>
        {!IS_PAGE && (
          <button type="button" className="link" aria-expanded={showHelp} onClick={() => setShowHelp((v) => !v)}>
            {showHelp ? 'Hide help' : 'How it works'}
          </button>
        )}
      </header>

      {showHelp && (
        <section className="panel quiet">
          <HowItWorks />
          <p className="hint">
            Everything stays in your browser. The copied chat is forgotten when Firefox closes, or when you press Clear.
          </p>
        </section>
      )}

      <main className="stack">
        {lastHandoff && <LastResult last={lastHandoff} onDismiss={() => setLastHandoff(null)} />}
        {importSection}
        {trayFirst ? traySection : tabSection}
        {trayFirst ? tabSection : traySection}
        {feedback && (
          <FeedbackNote
            feedback={feedback}
            locked={locked}
            onRetry={() => copyThisChat()}
            onSkipMissing={() => copyThisChat(true, true)}
            onRetryWithoutFiles={() => copyThisChat(false)}
            mediaHosts={tab.missingMedia}
            onGrantMedia={() => grantMediaAccess(true)}
            onDiagnostics={openDiagnostics}
            onDismiss={() => setFeedback(null)}
          />
        )}
      </main>

      {!IS_PAGE && (
        <footer className="foot">
          <button type="button" className="link" onClick={openImportPage}>
            Open .ctxbridge file
          </button>
          <button type="button" className="link" onClick={openDiagnostics}>
            Diagnostics
          </button>
        </footer>
      )}

      {showDiagnostics && diagnostics && (
        <Diagnostics
          diagnostics={diagnostics}
          onClose={() => setShowDiagnostics(false)}
          onCopied={(ok) =>
            setFeedback(
              ok
                ? { tone: 'ok', title: 'Diagnostics copied to the clipboard' }
                : { tone: 'error', title: 'Could not copy the diagnostics' }
            )
          }
        />
      )}
    </div>
  );
}

interface TabSectionProps {
  tab: ChatTab;
  tray: TraySummary | null;
  sameChat: boolean;
  capturing: boolean;
  progress: CaptureProgress | null;
  locked: boolean;
  includeAttachments: boolean;
  onToggleAttachments: (value: boolean) => void;
  onCopy: () => void;
  onCancel: () => void;
  onReload: () => void;
  onGrant: () => void;
  onGrantMedia: () => void;
}

function TabSection(props: TabSectionProps) {
  const { tab, tray, sameChat, capturing, progress, locked } = props;

  if (tab.status === 'loading') {
    return (
      <section className="panel" aria-busy="true">
        <Skeleton />
      </section>
    );
  }

  if (tab.status === 'ready' && tab.platform) {
    // One primary action at a time: pasting wins when something is copied from elsewhere.
    const primary = !tray || sameChat;
    return (
      <section className="panel" aria-labelledby="tab-heading">
        <h2 id="tab-heading" className="label">
          This tab
        </h2>
        <p className="name">{tab.title || 'Untitled chat'}</p>
        <p className="meta">{tab.platform.name}</p>
        {capturing ? (
          <div className="progress" role="status" aria-live="polite">
            <div className="row">
              <p className="name">Reading the conversation</p>
              <button type="button" className="btn small" onClick={props.onCancel}>
                Cancel
              </button>
            </div>
            <p className="meta mono">
              {plural(progress?.messagesFound ?? 0, 'message')}, {plural(progress?.imagesFound ?? 0, 'image')},{' '}
              {plural(progress?.filesFound ?? 0, 'file')}
            </p>
            {progress?.currentOperation && <p className="hint">{progress.currentOperation}</p>}
            <div className="track" aria-hidden="true">
              <span />
            </div>
            <p className="hint">You can close this window. The copy keeps going in the tab.</p>
          </div>
        ) : (
          <div className="stack-sm">
            <button type="button" className={`btn wide${primary ? ' primary' : ''}`} onClick={props.onCopy} disabled={locked}>
              {sameChat ? 'Copy this chat again' : tray ? 'Copy this chat instead' : 'Copy this chat'}
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={props.includeAttachments}
                onChange={(e) => props.onToggleAttachments(e.target.checked)}
                disabled={locked}
              />
              <span>Include files and images</span>
            </label>
            {props.includeAttachments && (tab.missingMedia?.length ?? 0) > 0 && (
              <>
                <p className="hint">
                  Firefox has not allowed ContextBridge to read pictures from {hostList(tab.missingMedia ?? [])} yet,
                  so they cannot be copied.
                </p>
                <button type="button" className="btn small" onClick={props.onGrantMedia} disabled={locked}>
                  Allow pictures
                </button>
              </>
            )}
          </div>
        )}
      </section>
    );
  }

  if (tab.status === 'no-script' && tab.platform) {
    return (
      <section className="panel" aria-labelledby="tab-heading">
        <h2 id="tab-heading" className="label">
          This tab
        </h2>
        <p className="name">{tab.platform.name}</p>
        <p className="body">ContextBridge is not active in this tab yet. This happens right after installing or updating it.</p>
        <button type="button" className="btn wide" onClick={props.onReload}>
          Reload tab
        </button>
      </section>
    );
  }

  if (tab.status === 'no-access' && tab.platform) {
    const host = tab.platform.hosts[0];
    return (
      <section className="panel" aria-labelledby="tab-heading">
        <h2 id="tab-heading" className="label">
          This tab
        </h2>
        <p className="name">{tab.platform.name}</p>
        <p className="body">ContextBridge needs your permission to read and fill in chats on {host}.</p>
        <button type="button" className="btn primary wide" onClick={props.onGrant} disabled={locked}>
          Allow on {host}
        </button>
      </section>
    );
  }

  return (
    <section className="panel quiet" aria-labelledby="tab-heading">
      <h2 id="tab-heading" className="label">
        This tab
      </h2>
      <p className="body">
        Not a supported chat. ContextBridge reads and fills in ChatGPT, Claude and Gemini.
        {tray ? ' For any other AI, use Copy as text.' : ''}
      </p>
    </section>
  );
}

function HowItWorks() {
  return (
    <ol className="steps">
      <li>
        <span className="step-verb">Copy</span>
        <span>Open the chat you want to move and press Copy this chat. Older messages and files are included.</span>
      </li>
      <li>
        <span className="step-verb">Paste</span>
        <span>Open the chat where you want to continue and press Paste into this chat, or start a new chat.</span>
      </li>
      <li>
        <span className="step-verb">Send</span>
        <span>The conversation lands in the message box, long history as transcript.md. Check it, then press Send.</span>
      </li>
    </ol>
  );
}

function Skeleton() {
  return (
    <div className="skeleton">
      <span />
      <span />
      <span />
      <p className="sr-only">Loading</p>
    </div>
  );
}

function LastResult({ last, onDismiss }: { last: LastHandoffResult; onDismiss: () => void }) {
  const name = platformName(last.targetPlatform);
  const manual = last.manualAttachmentRequiredFiles ?? [];
  let title: string;
  let detail: string | undefined;
  if (last.success) {
    title = `Added to the ${name} message box`;
    detail = manual.length > 0 ? describeFiles(last, name, {}, 8).join(' ') : undefined;
  } else if (last.failureReason === 'composer_not_found') {
    title = `Paste into ${name} did not finish`;
    detail = 'The message box was not found. Sign in or open a chat there, then press Paste into this chat.';
  } else if (last.failureReason === 'text_not_verified') {
    title = `Check the ${name} message box`;
    detail = 'ContextBridge could not confirm the text. If the box is empty, use Copy as text and paste it.';
  } else {
    title = `Paste into ${name} did not finish`;
    detail = last.message;
  }
  return (
    <div className={`note ${last.success ? (manual.length > 0 ? '' : 'ok') : 'error'}`} role="status">
      <div className="row">
        <p className="note-title">{title}</p>
        <button type="button" className="link" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
      {detail && <p className="note-body">{detail}</p>}
      <p className="meta">{timeAgo(last.at)}</p>
    </div>
  );
}

interface FeedbackNoteProps {
  feedback: Feedback;
  locked: boolean;
  onRetry: () => void;
  onSkipMissing: () => void;
  onRetryWithoutFiles: () => void;
  onDiagnostics: () => void;
  onDismiss: () => void;
  /** Picture servers Firefox has not allowed: offered with unreadable files. */
  mediaHosts?: string[];
  onGrantMedia?: () => void;
}

function FeedbackNote({
  feedback,
  locked,
  onRetry,
  onSkipMissing,
  onRetryWithoutFiles,
  onDiagnostics,
  onDismiss,
  mediaHosts,
  onGrantMedia,
}: FeedbackNoteProps) {
  const missing = feedback.missingFiles;
  // Unreadable files and a picture server without access: allowing it is the likely fix.
  const offerAccess = !!missing && !!onGrantMedia && (mediaHosts?.length ?? 0) > 0;
  const hasActions = feedback.retry || feedback.retryWithoutFiles || missing || feedback.diagnostics;
  return (
    <div className={`note ${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
      <div className="row">
        <p className="note-title">{feedback.title}</p>
        <button type="button" className="link" onClick={onDismiss} aria-label="Dismiss message">
          Dismiss
        </button>
      </div>
      {feedback.detail && <p className="note-body">{feedback.detail}</p>}
      {missing && missing.length > 0 && (
        <p className="note-body break">
          Not readable: {missing.slice(0, 3).join(', ')}
          {missing.length > 3 ? ` and ${missing.length - 3} more` : ''}
        </p>
      )}
      {offerAccess && (
        <p className="note-body">
          Firefox has not allowed ContextBridge to read pictures from {hostList(mediaHosts ?? [])}. Allow it and
          the copy starts again.
        </p>
      )}
      {hasActions && (
        <div className="note-actions">
          {offerAccess && (
            <button type="button" className="btn small primary" onClick={onGrantMedia} disabled={locked}>
              Allow pictures and copy
            </button>
          )}
          {missing && (
            <button type="button" className="btn small" onClick={onSkipMissing} disabled={locked}>
              {missing.length === 1 ? 'Skip missing file' : 'Skip missing files'}
            </button>
          )}
          {feedback.retry && (
            <button type="button" className="btn small" onClick={onRetry} disabled={locked}>
              Try again
            </button>
          )}
          {feedback.retryWithoutFiles && (
            <button type="button" className="btn small" onClick={onRetryWithoutFiles} disabled={locked}>
              Copy only the text
            </button>
          )}
          {feedback.diagnostics && (
            <button type="button" className="link" onClick={onDiagnostics}>
              Details
            </button>
          )}
        </div>
      )}
      {feedback.technical && (
        <details className="tech">
          <summary>Technical message</summary>
          <p className="mono">{feedback.technical}</p>
        </details>
      )}
    </div>
  );
}
