/**
 * Leaf storage utility for ChatGPT diagnostics persistence.
 *
 * Rules:
 * - MUST NOT import ChatGPTAdapter, crawler, registry, popup, or background code.
 * - Only imports plain types using `import type`.
 * - Zero module-level side-effects or async calls on load.
 */

import type { AdapterDiagnostics } from '../core/diagnostics/diagnostics';

export const CHATGPT_DIAGNOSTICS_STORAGE_KEYS = {
  DIAGNOSTICS: 'lastChatGPTDiagnostics',
  CRAWL_STATS: 'lastChatGPTCrawlStats',
} as const;

export interface LastChatGPTDiagnosticsPayload {
  diagnostics?: AdapterDiagnostics;
  crawlStats?: Record<string, unknown>;
}

/**
 * Persists the latest ChatGPT diagnostics and crawl stats to browser.storage.local.
 */
export async function saveLastChatGPTDiagnostics(
  payload: LastChatGPTDiagnosticsPayload
): Promise<void> {
  if (typeof browser === 'undefined' || !browser?.storage?.local) {
    return;
  }

  try {
    const toSet: Record<string, unknown> = {};
    if (payload.diagnostics !== undefined) {
      toSet[CHATGPT_DIAGNOSTICS_STORAGE_KEYS.DIAGNOSTICS] = payload.diagnostics;
    }
    if (payload.crawlStats !== undefined) {
      toSet[CHATGPT_DIAGNOSTICS_STORAGE_KEYS.CRAWL_STATS] = payload.crawlStats;
    }
    await browser.storage.local.set(toSet);
  } catch {
    // Ignore storage failure (e.g. quota, permissions, or context invalidation)
  }
}

/**
 * Loads the last persisted ChatGPT diagnostics and crawl stats from browser.storage.local.
 */
export async function loadLastChatGPTDiagnostics(): Promise<LastChatGPTDiagnosticsPayload | null> {
  if (typeof browser === 'undefined' || !browser?.storage?.local) {
    return null;
  }

  try {
    const keys = [
      CHATGPT_DIAGNOSTICS_STORAGE_KEYS.DIAGNOSTICS,
      CHATGPT_DIAGNOSTICS_STORAGE_KEYS.CRAWL_STATS,
    ];
    const stored = (await browser.storage.local.get(keys)) as {
      lastChatGPTDiagnostics?: AdapterDiagnostics;
      lastChatGPTCrawlStats?: Record<string, unknown>;
    };

    if (!stored?.lastChatGPTDiagnostics && !stored?.lastChatGPTCrawlStats) {
      return null;
    }

    return {
      diagnostics: stored.lastChatGPTDiagnostics,
      crawlStats: stored.lastChatGPTCrawlStats,
    };
  } catch {
    return null;
  }
}

/**
 * Clears persisted ChatGPT diagnostics from storage.
 */
export async function clearLastChatGPTDiagnostics(): Promise<void> {
  if (typeof browser === 'undefined' || !browser?.storage?.local) {
    return;
  }

  try {
    await browser.storage.local.remove([
      CHATGPT_DIAGNOSTICS_STORAGE_KEYS.DIAGNOSTICS,
      CHATGPT_DIAGNOSTICS_STORAGE_KEYS.CRAWL_STATS,
    ]);
  } catch {
    // Ignore failure
  }
}
