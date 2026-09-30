/**
 * Static facts about the supported chat sites, shared by the popup and the background.
 * Kept free of adapter imports so extension pages do not bundle the DOM crawlers.
 */

export type SupportedPlatformId = 'chatgpt' | 'claude' | 'gemini';

export interface PlatformInfo {
  id: SupportedPlatformId;
  /** Short name for buttons and labels. */
  name: string;
  /** Where "Start a new chat" goes. */
  newChatUrl: string;
  /** Host permission patterns the content script needs. */
  origins: string[];
  hosts: string[];
  /**
   * Most files the site takes in one message. Gemini documents 10 per prompt; ChatGPT is kept
   * at a conservative 10; Claude takes 20.
   */
  maxFilesPerMessage: number;
  /** The site reads audio and video files (Gemini does; ChatGPT and Claude do not). */
  acceptsAudioVideo: boolean;
}

export const PLATFORMS: readonly PlatformInfo[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    newChatUrl: 'https://chatgpt.com/',
    origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    hosts: ['chatgpt.com', 'chat.openai.com'],
    maxFilesPerMessage: 10,
    acceptsAudioVideo: false,
  },
  {
    id: 'claude',
    name: 'Claude',
    newChatUrl: 'https://claude.ai/new',
    origins: ['https://claude.ai/*'],
    hosts: ['claude.ai'],
    maxFilesPerMessage: 20,
    acceptsAudioVideo: false,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    newChatUrl: 'https://gemini.google.com/app',
    origins: ['https://gemini.google.com/*'],
    hosts: ['gemini.google.com'],
    maxFilesPerMessage: 10,
    acceptsAudioVideo: true,
  },
];

export function platformInfo(id?: string | null): PlatformInfo | undefined {
  return PLATFORMS.find((p) => p.id === id);
}

export function platformForUrl(url?: string | null): PlatformInfo | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return undefined;
    host = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return PLATFORMS.find((p) => p.hosts.includes(host));
}

export function platformName(id?: string | null): string {
  return platformInfo(id)?.name ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'another AI');
}
