import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter } from '@silo/core';

export class ViewMemoryCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('memory-view')
    .setDescription('View your stored memories')
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Filter by memory type')
        .setRequired(false)
        .addChoices(
          { name: 'Conversation', value: 'conversation' },
          { name: 'Preference', value: 'preference' },
          { name: 'Summary', value: 'summary' },
          { name: 'Temporary', value: 'temporary' },
          { name: 'Mood', value: 'mood' }
        )
    );

  constructor(private db: DatabaseAdapter) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const contextType = interaction.options.getString('type') || undefined;
    const memories = await this.db.getUserMemories(interaction.user.id, contextType);

    if (memories.length === 0) {
      await interaction.editReply('No memories found.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Your Memories')
      .setColor(0x5865f2)
      .setDescription(`Found ${memories.length} ${contextType || 'total'} memories`);

    for (const memory of memories.slice(0, 10)) {
      const expiresText = memory.expiresAt
        ? `\nExpires: <t:${Math.floor(new Date(memory.expiresAt).getTime() / 1000)}:R>`
        : '';
      embed.addFields({
        name: `${memory.contextType} - ${memory.id.slice(0, 8)}`,
        value: `${memory.memoryContent.slice(0, 200)}${memory.memoryContent.length > 200 ? '...' : ''}${expiresText}`,
        inline: false
      });
    }

    if (memories.length > 10) {
      embed.setFooter({ text: `Showing 10 of ${memories.length} memories` });
    }

    await interaction.editReply({ embeds: [embed] });
  }
}
