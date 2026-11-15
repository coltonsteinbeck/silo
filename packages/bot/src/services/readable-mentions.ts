import type { Message } from 'discord.js';

const USER_MENTION = /<@!?(\d{15,22})>/g;

export function readableName(value: string | null | undefined): string {
  const name = Array.from(
    (value || '')
      .replace(/[\p{C}<>@`"'{}#*\u005b-\u005d]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
    .slice(0, 64)
    .join('')
    .trim();
  return name || 'someone';
}

/** Render only Discord-resolved user mentions; keep IDs in message metadata. */
export function renderReadableUserMentions(
  content: string,
  message?: Pick<Message<boolean>, 'mentions'>
): string {
  return content.replace(USER_MENTION, (_mention, userId: string) => {
    const member = message?.mentions?.members?.get(userId);
    const user = message?.mentions?.users?.get(userId);
    const name = readableName(member?.displayName || user?.globalName || user?.username);
    return `user “${name}”`;
  });
}

export function readableMessageAuthor(
  message: Pick<Message<boolean>, 'member' | 'author'>
): string {
  return readableName(
    message.member?.displayName || message.author?.globalName || message.author?.username
  );
}
