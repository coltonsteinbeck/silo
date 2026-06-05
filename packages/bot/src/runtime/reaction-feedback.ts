import type {
  Client,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  User
} from 'discord.js';
import type { logger as coreLogger } from '@silo/core';
import type { AdminAdapter } from '../database/admin-adapter';
import type { PermissionManager } from '../permissions/manager';

type Logger = Pick<typeof coreLogger, 'debug' | 'info' | 'warn' | 'error'>;

export type ReactionFeedbackType = 'positive' | 'negative' | 'regenerate' | 'save' | 'delete';

export function mapFeedbackEmoji(emoji: string | null): ReactionFeedbackType | null {
  switch (emoji) {
    case '👍':
      return 'positive';
    case '👎':
      return 'negative';
    case '🔄':
      return 'regenerate';
    case '💾':
      return 'save';
    case '🗑️':
      return 'delete';
    default:
      return null;
  }
}

export async function handleReactionFeedback({
  reaction,
  user,
  client,
  adminDb,
  permissions,
  log
}: {
  reaction: MessageReaction | PartialMessageReaction;
  user: User | PartialUser;
  client: Client;
  adminDb: AdminAdapter;
  permissions: PermissionManager;
  log: Logger;
}): Promise<void> {
  if (user.bot) {
    return;
  }

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      log.error('Failed to fetch reaction:', error);
      return;
    }
  }

  const actor = user.partial ? await user.fetch() : user;
  const message = reaction.message;
  if (!message.guildId || message.author?.id !== client.user?.id) {
    return;
  }

  const feedbackType = mapFeedbackEmoji(reaction.emoji.name);
  if (!feedbackType) {
    return;
  }

  try {
    await adminDb.logFeedback({
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      userId: actor.id,
      feedbackType
    });

    if (feedbackType !== 'delete' || !message.deletable) {
      return;
    }

    if (message.interaction?.user.id === actor.id) {
      await message.delete();
      return;
    }

    if (!message.guild) {
      return;
    }

    const member = await message.guild.members.fetch(actor.id);
    const canModerate = await permissions.canModerate(message.guildId, actor.id, member);
    if (canModerate) {
      await message.delete();
    }
  } catch (error) {
    log.error('Error handling reaction:', error);
  }
}
