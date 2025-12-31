import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter } from '@silo/core';

export class ClearMemoryCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('memory-clear')
    .setDescription('Clear memories by ID or type')
    .addStringOption(option =>
      option.setName('id').setDescription('Specific memory ID to delete').setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Clear all memories of this type')
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

    const memoryId = interaction.options.getString('id');
    const contextType = interaction.options.getString('type');

    if (!memoryId && !contextType) {
      await interaction.editReply('Please specify either a memory ID or type to clear.');
      return;
    }

    if (memoryId) {
      // Support partial ID matching (user sees truncated IDs in memory-view)
      const memory = await this.db.findUserMemoryByIdPrefix(interaction.user.id, memoryId);
      if (!memory) {
        await interaction.editReply(`No memory found with ID starting with \`${memoryId}\`.`);
        return;
      }
      await this.db.deleteUserMemory(memory.id);
      await interaction.editReply(`Memory \`${memory.id.slice(0, 8)}\` deleted successfully.`);
      return;
    }

    if (contextType) {
      const memories = await this.db.getUserMemories(interaction.user.id, contextType);
      for (const memory of memories) {
        await this.db.deleteUserMemory(memory.id);
      }
      await interaction.editReply(`Deleted ${memories.length} ${contextType} memories.`);
    }
  }
}
