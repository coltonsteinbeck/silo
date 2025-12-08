import {
  SlashCommandBuilder,
  ChatInputCommandInteraction
} from 'discord.js';
import type { Command } from './types';
import { voiceSessionManager } from '../voice';

export const StopSpeakingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('stopspeaking')
    .setDescription('Stop your voice conversation with Silo'),

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // Check if user has an active session
    if (!voiceSessionManager.isUserSpeaking(guildId, userId)) {
      await interaction.reply({
        content: 'You don\'t have an active voice session.',
        ephemeral: true
      });
      return;
    }

    try {
      const stopped = await voiceSessionManager.stopSpeaking(guildId, userId);
      
      if (stopped) {
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
      console.error('[StopSpeakingCommand] Error:', error);
      await interaction.reply({
        content: 'An error occurred while stopping the voice session.',
        ephemeral: true
      });
    }
  }
};
