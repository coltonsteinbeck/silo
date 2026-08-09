import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type VoiceChannel,
  type VoiceState
} from 'discord.js';
import type { Command } from './types';
import { radioManager, type RadioManager } from '../voice/radio/manager';

export class RadioCommand implements Command {
  public readonly data = new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Play audio from YouTube or a Spotify track in a voice channel')
    .addStringOption(option =>
      option
        .setName('link')
        .setDescription('YouTube video/playlist or Spotify track URL')
        .setRequired(true)
    )
    .addChannelOption(option =>
      option
        .setName('channel')
        .setDescription('The voice channel to play in')
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildVoice)
    );

  constructor(private readonly manager: RadioManager = radioManager) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const link = interaction.options.getString('link', true).trim();
    const selectedChannel = interaction.options.getChannel('channel', true);
    if (!interaction.guild || selectedChannel.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: 'Please provide a regular server voice channel.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      });
      return;
    }

    const channel = await interaction.guild.channels.fetch(selectedChannel.id);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: 'Could not find that voice channel.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      });
      return;
    }

    await this.manager.play(interaction, link, channel as VoiceChannel);
  }

  handleButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
    return this.manager.handleButtonInteraction(interaction);
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): boolean {
    return this.manager.handleVoiceStateUpdate(oldState, newState);
  }

  stopAll(reason = 'shutdown'): Promise<void> {
    return this.manager.stopAll(reason);
  }
}
