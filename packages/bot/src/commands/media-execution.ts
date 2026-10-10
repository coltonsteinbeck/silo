import {
  GuildMember,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction
} from 'discord.js';
import type { QuotaMiddleware } from '../middleware/quota';

type MediaInteraction = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;
export class MediaQuotaDeniedError extends Error {}

export async function executeCommandMedia<T>(
  interaction: MediaInteraction,
  quota: QuotaMiddleware | undefined,
  usageType: 'images' | 'video_tokens',
  amount: number,
  signal: AbortSignal,
  execute: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  if (
    !quota ||
    !interaction.guildId ||
    !(interaction.member instanceof GuildMember) ||
    interaction.member.id !== interaction.user.id ||
    interaction.member.guild.id !== interaction.guildId
  ) {
    throw new Error('Media quota admission is unavailable');
  }
  const result = await quota.executeReserved({
    operationKey: `discord:${interaction.id}:media`,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    member: interaction.member,
    usageType,
    requestedAmount: amount,
    minimumAmount: amount,
    beforeAttempt: () => signal.throwIfAborted(),
    execute: async () => {
      signal.throwIfAborted();
      return execute();
    },
    getActualAmount: () => amount
  });
  signal.throwIfAborted();
  if (!result.allowed) throw new MediaQuotaDeniedError(result.reason);
  return result.value;
}
