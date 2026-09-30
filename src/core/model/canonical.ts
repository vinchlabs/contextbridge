/**
 * Canonical Conversation Model for ContextBridge
 * Version 1
 */

export type PlatformId = 'chatgpt' | 'gemini' | 'claude' | (string & {});

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface MarkdownContentPart {
  type: 'markdown';
  markdown: string;
}

export interface CodeContentPart {
  type: 'code';
  code: string;
  language?: string;
  title?: string;
}

export interface ImageContentPart {
  type: 'image';
  blobSha256: string;
  altText?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface FileContentPart {
  type: 'file';
  blobSha256: string;
  filename: string;
  mimeType: string;
  byteSize?: number;
}

export interface LinkContentPart {
  type: 'link';
  url: string;
  title?: string;
}

export interface CitationContentPart {
  type: 'citation';
  text: string;
  url?: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
}

export interface TableContentPart {
  type: 'table';
  headers: string[];
  rows: string[][];
  caption?: string;
}

export interface ToolResultContentPart {
  type: 'tool-result';
  toolName?: string;
  input?: unknown;
  output: string | unknown;
  status?: 'success' | 'error';
}

export interface UnknownContentPart {
  type: 'unknown';
  rawText?: string;
  platformType?: string;
  metadata?: Record<string, unknown>;
}

export type ContentPart =
  | TextContentPart
  | MarkdownContentPart
  | CodeContentPart
  | ImageContentPart
  | FileContentPart
  | LinkContentPart
  | CitationContentPart
  | TableContentPart
  | ToolResultContentPart
  | UnknownContentPart;

export interface Message {
  id: string;
  role: MessageRole;
  sequence: number;
  createdAt?: string;
  content: ContentPart[];
  metadata?: Record<string, unknown>;
}

export type BlobRole =
  | 'user-upload'
  | 'assistant-generated'
  | 'inline-image'
  | 'attachment'
  | 'other';

export interface BlobMetadata {
  sha256: string;
  mimeType: string;
  byteSize: number;
  filename?: string;
  role?: BlobRole;
  captureSource?: string;
  originalUrl?: string;
}

export interface StoredBlob {
  metadata: BlobMetadata;
  data: Uint8Array;
}

export interface ConversationMetadata {
  id?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  custom?: Record<string, unknown>;
}

export interface ConversationSnapshot {
  schemaVersion: 1;
  id: string;
  sourcePlatform: PlatformId;
  sourceConversationId?: string;
  title?: string;
  sourceUrl?: string;
  capturedAt: string;
  messages: Message[];
  attachments: BlobMetadata[];
  metadata?: Record<string, unknown>;
}

export const CANONICAL_SCHEMA_VERSION = 1 as const;
