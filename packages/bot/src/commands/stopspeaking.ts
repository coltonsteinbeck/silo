import { SlashCommandBuilder, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import type { Command } from './types';
import { voiceSessionManager } from '../voice';
import type { QuotaMiddleware } from '../middleware/quota';
import { logger } from '@silo/core';

export class StopSpeakingCommand implements Command {
  public readonly data = new SlashCommandBuilder()
    .setName('stopspeaking')
    .setDescription('Stop your voice conversation with Silo');

  constructor(private quotaMiddleware?: QuotaMiddleware) { }

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // Check if user has an active session
    if (!voiceSessionManager.isUserSpeaking(guildId, userId)) {
      await interaction.reply({
        content: "You don't have an active voice session.",
        ephemeral: true
      });
      return;
    }

    try {
      // Get session start time before stopping
      const session = voiceSessionManager.getSession(guildId);
      const sessionStartTime = session?.createdAt;

      const stopped = await voiceSessionManager.stopSpeaking(guildId, userId);

      if (stopped) {
        // Record voice minutes used
        if (this.quotaMiddleware && sessionStartTime) {
          const durationMs = Date.now() - sessionStartTime.getTime();
          const durationMinutes = Math.ceil(durationMs / 60000);

          const member = interaction.member as GuildMember;
          await this.quotaMiddleware.recordUsageAtomic(
            guildId,
            userId,
            member,
            'voice_minutes',
            durationMinutes
          );

          logger.debug('Voice session ended, usage recorded', {
            guildId,
            userId,
            durationMs,
            durationMinutes
          });
        }

        const remainingSpeakers = voiceSessionManager.getActiveSpeakerCount(guildId);

        // If no more speakers, optionally leave the channel
        if (remainingSpeakers === 0) {
          // Leave the voice channel when no one is speaking
          await voiceSessionManager.leaveGuild(guildId);
          await interaction.reply({
            content: 'Voice session ended. Silo has left the voice channel.',
            ephemeral: false
          });
        } else {
          await interaction.reply({
            content: `Your voice session has ended. ${remainingSpeakers} other speaker(s) still active.`,
            ephemeral: true
          });
        }
      } else {
        await interaction.reply({
          content: 'Failed to stop voice session.',
          ephemeral: true
        });
      }
    } catch (error) {
      logger.error('[StopSpeakingCommand] Error:', error);
      await interaction.reply({
        content: 'An error occurred while stopping the voice session.',
        ephemeral: true
      });
    }
  }
}
