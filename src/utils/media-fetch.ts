/**
 * Fetching the pictures, videos and files a chat shows.
 *
 * Content scripts first fetch directly. Cross-origin media (Gemini's googleusercontent.com,
 * ChatGPT's oaiusercontent.com) often has no CORS headers, which a Firefox MV3 content script
 * cannot read. The background may fetch it instead, but only for https URLs on the extension's
 * own host permissions, so a page cannot turn the extension into a fetcher for other sites.
 */

import type { FetchMediaResponse } from './messaging';
import { fromWireBytes } from './wire-bytes';

/** Largest single file ContextBridge copies (videos included). Larger ones are "not included". */
export const MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Host permission patterns ("https://*.example.com/*", "https://example.com/*") -> does `url`
 * fall under one of them? Only https, no credentials in the URL.
 */
export function isUrlOnHostPatterns(url: string, patterns: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  for (const pattern of patterns) {
    const m = /^https:\/\/(\*\.)?([^/*]+)\/\*$/i.exec(pattern.trim());
    if (!m) continue;
    const base = m[2]!.toLowerCase();
    if (host === base || (m[1] && host.endsWith(`.${base}`))) return true;
  }
  return false;
}

export class MediaTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`File is larger than ${Math.round(MEDIA_MAX_BYTES / (1024 * 1024))} MB`);
    this.name = 'MediaTooLargeError';
  }
}

/** Asks the background to fetch `url`; null when there is no extension runtime (tests). */
export async function fetchMediaViaBackground(url: string): Promise<{ data: Uint8Array; mimeType: string } | null> {
  const runtime = typeof browser !== 'undefined' ? browser?.runtime : undefined;
  if (!runtime?.sendMessage) return null;
  const res = (await runtime.sendMessage({ type: 'FETCH_MEDIA', url })) as FetchMediaResponse | undefined;
  if (!res?.ok || !res.data) {
    if (res?.error === 'too_large') throw new MediaTooLargeError(MEDIA_MAX_BYTES + 1);
    throw new Error(`Background fetch failed (${res?.status ?? res?.error ?? 'no answer'})`);
  }
  return { data: fromWireBytes(res.data), mimeType: res.mimeType || 'application/octet-stream' };
}
