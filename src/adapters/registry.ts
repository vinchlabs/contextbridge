/**
 * Registry of platform adapters
 */

import { ChatAdapter } from './adapter';
import { ChatGPTAdapter } from './chatgpt/adapter';
import { GeminiAdapter } from './gemini/adapter';
import { ClaudeAdapter } from './claude/adapter';
import { PlatformId } from '../core/model/canonical';

const ADAPTERS: ChatAdapter[] = [
  new ChatGPTAdapter(),
  new GeminiAdapter(),
  new ClaudeAdapter(),
];

export function getAllAdapters(): ChatAdapter[] {
  return [...ADAPTERS];
}

export function getAdapterById(id: PlatformId | string): ChatAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export function findAdapterForUrl(url: string): ChatAdapter | undefined {
  return ADAPTERS.find((a) => a.detect(url));
}
