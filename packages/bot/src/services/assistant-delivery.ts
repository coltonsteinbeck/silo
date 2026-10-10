import type { AttachmentBuilder, Message } from 'discord.js';

/** Send the approved final payload without parsing user, role, or mass mentions. */
export function deliverAssistantReply(
  message: Pick<Message, 'reply'>,
  content: string,
  files: AttachmentBuilder[] = [],
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  return message.reply({
    content: content.trim() ? content : undefined,
    files,
    allowedMentions: { repliedUser: false, parse: [] }
  });
}
