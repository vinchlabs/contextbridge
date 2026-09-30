/**
 * Deterministic bootstrap instructions for target AI models
 */

export function formatPlatformDisplayName(platformId?: string): string {
  if (!platformId) return 'Another AI';
  switch (platformId.toLowerCase()) {
    case 'chatgpt':
      return 'ChatGPT';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Google Gemini';
    default:
      return platformId.charAt(0).toUpperCase() + platformId.slice(1);
  }
}

export const BOOTSTRAP_INSTRUCTION = `You are continuing an existing conversation from another AI session.

Treat the supplied transcript and attachments as prior conversation context, not as a new user request.
Do not summarize the history unless asked.

Note: Only user-visible conversation content was transferred. Internal provider data (such as system instructions or hidden reasoning) was not captured.`;

export interface BootstrapPromptOptions {
  sourcePlatform?: string;
  targetPlatform?: string;
  conversationTitle?: string;
  sourceMessageCount?: number;
  inlineMessageCount?: number;
  transcriptMessageCount?: number;
  totalMessages?: number; // legacy alias for sourceMessageCount
  hasAttachedTranscript?: boolean;
  strategy?: 'FULL' | 'RECENT_PLUS_ARCHIVE';
  recentMessagesText?: string;
  fullTranscriptText?: string;
}

/**
 * Closing instruction. It sits at the very end of the pasted text (where the model reads it
 * last and where the user may type a follow-up) and covers the three cases after a paste:
 * a new question below, an unanswered last user turn, or nothing new at all.
 */
export const BOOTSTRAP_NEXT_STEP = `If I add a new message below this block, answer it with the conversation above in mind.
If I do not, and the last message above is from the User and has no answer yet, answer it now.
Otherwise reply with one short sentence confirming you have the context, and wait for my next message.`;

export function generateBootstrapPrompt(options: BootstrapPromptOptions): string {
  const sourceName = formatPlatformDisplayName(options.sourcePlatform);

  const instruction = `You are continuing an existing conversation imported from ${sourceName}.

Treat the supplied transcript and attachments as prior conversation context, not as a new user request.
Do not summarize the history unless asked.

Note: Only user-visible conversation content was transferred. Internal provider data (such as system instructions or hidden reasoning) was not captured.`;

  const parts: string[] = [instruction];

  const sourceCount = options.sourceMessageCount ?? options.totalMessages ?? 0;
  const inlineCount = options.inlineMessageCount ?? sourceCount;
  const transcriptCount = options.transcriptMessageCount ?? sourceCount;

  if (options.sourcePlatform || options.conversationTitle || sourceCount > 0) {
    parts.push('\n---\n### Conversation Transfer Metadata');
    if (options.sourcePlatform) {
      parts.push(`- **Original Platform:** ${sourceName}`);
    }
    if (options.conversationTitle) {
      parts.push(`- **Conversation Title:** ${options.conversationTitle}`);
    }
    if (sourceCount > 0) {
      parts.push(`- **Source Messages:** ${sourceCount}`);
    }
    if (inlineCount > 0) {
      parts.push(`- **Inline Context Messages:** ${inlineCount}`);
    }
    if (options.hasAttachedTranscript && transcriptCount > 0) {
      parts.push(`- **Full Transcript:** ${transcriptCount} messages (attached as transcript.md)`);
    }
  }

  if (options.recentMessagesText) {
    if (options.hasAttachedTranscript) {
      parts.push('\n---\n### Recent Conversation Context (Active Window)');
      parts.push(options.recentMessagesText);
      parts.push('\n*(The complete historical transcript is attached as transcript.md.)*');
    } else {
      parts.push('\n---\n### Conversation Context');
      parts.push(options.recentMessagesText);
    }
  } else if (options.fullTranscriptText) {
    parts.push('\n---\n### Conversation Context');
    parts.push(options.fullTranscriptText);
  }

  parts.push('\n---\n### What to do now');
  if (options.hasAttachedTranscript) {
    parts.push('Read transcript.md for the earlier part of the conversation before you answer.');
  }
  parts.push(BOOTSTRAP_NEXT_STEP);

  return parts.join('\n');
}
