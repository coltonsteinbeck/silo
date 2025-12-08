import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ChannelType
} from 'discord.js';
import type { Command } from './types';
import { voiceSessionManager } from '../voice';
import { AdminAdapter } from '../database/admin-adapter';
import { systemPromptManager } from '../security';

export class SpeakCommand implements Command {
  public readonly data = new SlashCommandBuilder()
    .setName('speak')
    .setDescription('Start a voice conversation with Silo in your current voice channel')
    .addStringOption(option =>
      option
        .setName('voice')
        .setDescription('Voice to use for responses')
        .setRequired(false)
        .addChoices(
          { name: 'Alloy (neutral)', value: 'alloy' },
          { name: 'Echo (male)', value: 'echo' },
          { name: 'Fable (british)', value: 'fable' },
          { name: 'Onyx (deep male)', value: 'onyx' },
          { name: 'Nova (female)', value: 'nova' },
          { name: 'Shimmer (soft female)', value: 'shimmer' }
        )
    );

  constructor(private adminDb: AdminAdapter) {}

  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.member as GuildMember;
    const voiceChannel = member.voice.channel;

    // Check if user is in a voice channel
    if (!voiceChannel) {
      await interaction.reply({
        content: 'You need to be in a voice channel to use this command.',
        ephemeral: true
      });
      return;
    }

    // Check if it's a valid voice channel type
    if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
      await interaction.reply({
        content: 'Please join a regular voice channel.',
        ephemeral: true
      });
      return;
    }

    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    // Check if user is already speaking
    if (voiceSessionManager.isUserSpeaking(guildId, userId)) {
      await interaction.reply({
        content: 'You already have an active voice session. Use `/stopspeaking` to end it first.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    try {
      // Get OpenAI API key from environment
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        await interaction.editReply({
          content: 'Voice features are not configured. Please contact the bot administrator.'
        });
        return;
      }

      // Get the voice system prompt for this guild
      const { prompt: dbPrompt, enabled: promptEnabled } = await this.adminDb.getSystemPrompt(guildId, true);
      const promptConfig = systemPromptManager.getEffectivePrompt(dbPrompt, promptEnabled, true);
      const instructions = promptConfig.prompt || 
        'You are a helpful AI assistant in a Discord voice channel. Keep responses concise and conversational.';

      // Join the voice channel if not already connected
      const connection = await voiceSessionManager.joinChannel(voiceChannel);

      // Start the realtime session for this user with custom instructions
      const voice = interaction.options.getString('voice') || 'alloy';
      const session = await voiceSessionManager.startSpeaking(guildId, userId, apiKey, { 
        voice,
        instructions
      });
      
      // Configure voice preference
      if (session) {
        session.attachConnection(connection);
      }

      const activeSpeakers = voiceSessionManager.getActiveSpeakerCount(guildId);
      const speakerInfo = activeSpeakers > 1 
        ? `There are now ${activeSpeakers} active speakers in this channel.`
        : '';

      await interaction.editReply({
        content: `Voice session started in **${voiceChannel.name}**. Speak naturally and Silo will respond. ${speakerInfo}\n\nUse \`/stopspeaking\` when you're done.`
      });

    } catch (error) {
      console.error('[SpeakCommand] Error:', error);
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await interaction.editReply({
        content: `Failed to start voice session: ${errorMessage}`
      });
    }
  }
}
