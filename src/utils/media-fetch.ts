/**
 * Fetching the pictures, videos and files a chat shows.
 *
 * Content scripts first fetch directly. Cross-origin media (Gemini's googleusercontent.com,
 * ChatGPT's oaiusercontent.com) often has no CORS headers, which a Firefox MV3 content script
 * cannot read. The background may fetch it instead, but only for https URLs on the extension's
 * own host permissions, so a page cannot turn the extension into a fetcher for other sites.
 *
 * When that fails too (Firefox keeps the page's Google session out of the extension's requests),
 * the background asks the chat page itself to read the file (isPageFetchAllowed).
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

/**
 * Google image hosts Gemini pictures can come from that are not host permissions. They are only
 * ever read through the chat page itself, never by the extension.
 */
const PAGE_ONLY_MEDIA_HOSTS = ['https://*.ggpht.com/*'];

/** The first host permission pattern that covers `url` (see isUrlOnHostPatterns), if any. */
export function hostPatternFor(url: string, patterns: readonly string[]): string | undefined {
  return patterns.find((pattern) => isUrlOnHostPatterns(url, [pattern]));
}

/** "https://*.googleusercontent.com/*" -> "googleusercontent.com", for messages. */
export function hostOfPattern(pattern: string): string {
  return /^https:\/\/(?:\*\.)?([^/*]+)\/\*$/i.exec(pattern.trim())?.[1] ?? pattern;
}

/**
 * May the background read `url` through the chat page's own fetch() (MAIN world)? That fetch
 * carries the page's session and stays under the page's CORS rules, so it reads nothing the page
 * could not read itself. Allowed: https URLs on the host permissions or Google's image hosts,
 * the page's own origin, and blob: URLs the page created. `pageUrl` is the asking frame's URL.
 */
export function isPageFetchAllowed(url: string, pageUrl: string | undefined, patterns: readonly string[]): boolean {
  let target: URL;
  let page: URL;
  try {
    target = new URL(url);
    page = new URL(pageUrl ?? '');
  } catch {
    return false;
  }
  if (page.protocol !== 'https:') return false;
  // "blob:https://gemini.google.com/<uuid>" belongs to the page that created it.
  if (target.protocol === 'blob:') {
    try {
      const creator = new URL(url.slice('blob:'.length));
      return creator.protocol === 'https:' && creator.origin === page.origin;
    } catch {
      return false;
    }
  }
  if (target.protocol !== 'https:' || target.username || target.password) return false;
  return target.origin === page.origin || isUrlOnHostPatterns(url, [...patterns, ...PAGE_ONLY_MEDIA_HOSTS]);
}

export class MediaTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`File is larger than ${Math.round(MEDIA_MAX_BYTES / (1024 * 1024))} MB`);
    this.name = 'MediaTooLargeError';
  }
}

/**
 * Asks the background to fetch `url`; null when there is no extension runtime (tests).
 * `picture`: the page may also read the picture's pixels when fetch() fails.
 */
export async function fetchMediaViaBackground(
  url: string,
  picture = false
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  const runtime = typeof browser !== 'undefined' ? browser?.runtime : undefined;
  if (!runtime?.sendMessage) return null;
  const res = (await runtime.sendMessage({ type: 'FETCH_MEDIA', url, picture })) as FetchMediaResponse | undefined;
  if (!res?.ok || !res.data) {
    if (res?.error === 'too_large') throw new MediaTooLargeError(MEDIA_MAX_BYTES + 1);
    const status = res?.status ? `HTTP ${res.status}, ` : '';
    throw new Error(`${status}${res?.error ?? 'no answer'}`);
  }
  return { data: fromWireBytes(res.data), mimeType: res.mimeType || 'application/octet-stream' };
}

/** "blob:https://gemini.google.com" or "https://lh3.googleusercontent.com": never a path or token. */
export function describeMediaSource(url: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? 'unknown';
  try {
    const inner = scheme === 'blob' ? new URL(url.slice('blob:'.length)) : new URL(url);
    if (inner.protocol === 'http:' || inner.protocol === 'https:') {
      return scheme === 'blob' ? `blob:${inner.origin}` : inner.origin;
    }
  } catch {
    // not a URL with a host
  }
  return `${scheme}:`;
}

/** Every way of reading a file failed; `trail` says how each one failed (no URLs, no bytes). */
export class MediaReadError extends Error {
  constructor(readonly trail: string[]) {
    super(trail.join(' | ') || 'Could not read the file');
    this.name = 'MediaReadError';
  }
}
