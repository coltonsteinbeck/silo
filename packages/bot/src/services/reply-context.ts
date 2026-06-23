import type { Message } from 'discord.js';
import { sanitizeDiscordMassMentions } from '../security/output-sanitizer';
import { sanitizeAssistantContextForPrompt } from './conversation-history-sanitizer';

export interface ResolvedReplyMessage {
  messageId: string;
  userId: string;
  content: string;
  imageUrls: string[];
  isBot?: boolean;
  omittedReason?: string | null;
}

export interface ResolvedReplyContext {
  chain: ResolvedReplyMessage[];
  directReplyMessageId: string | null;
  directReplyUserId: string | null;
  textContext: string;
}

function normalizeContent(content: string): string {
  return sanitizeDiscordMassMentions(content).replace(/\s+/g, ' ').trim();
}

function getImageUrls(message: Message<boolean>): string[] {
  return message.attachments
    .filter(att => att.contentType?.startsWith('image/') && att.size <= 20 * 1024 * 1024)
    .map(att => att.url);
}

export async function resolveReplyContext(
  message: Message<boolean>,
  maxDepth = 2
): Promise<ResolvedReplyContext> {
  const chain: ResolvedReplyMessage[] = [];
  let cursor: Message<boolean> = message;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (!cursor.reference?.messageId) {
      break;
    }

    let referenced: Message<boolean> | null = null;
    try {
      referenced = await cursor.fetchReference();
    } catch {
      break;
    }

    if (!referenced) {
      break;
    }

    const isBot = Boolean(referenced.author?.bot);
    const normalizedContent = normalizeContent(referenced.content || '');
    const contextSanitization = isBot
      ? sanitizeAssistantContextForPrompt(normalizedContent)
      : { content: normalizedContent, reason: null };

    chain.push({
      messageId: referenced.id,
      userId: referenced.author?.id || 'unknown',
      content: contextSanitization.content,
      imageUrls: getImageUrls(referenced),
      isBot,
      omittedReason: contextSanitization.reason
    });

    cursor = referenced;
  }

  const directReply = chain[0] || null;
  const textContext = chain
    .map((item, index) => {
      const level = index + 1;
      const parts: string[] = [`[Reply level ${level} | user ${item.userId}]`];
      if (item.content) {
        parts.push(item.content);
      }
      if (item.imageUrls.length > 0) {
        parts.push(`[Attached images: ${item.imageUrls.length}]`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  return {
    chain,
    directReplyMessageId: directReply?.messageId || null,
    directReplyUserId: directReply?.userId || null,
    textContext
  };
}
