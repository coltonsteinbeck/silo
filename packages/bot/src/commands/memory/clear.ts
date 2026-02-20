import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter } from '@silo/core';
import { PermissionManager } from '../../permissions/manager';

export class ClearMemoryCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('memory-clear')
    .setDescription('Clear memories by ID or type')
    .addStringOption(option =>
      option
        .setName('scope')
        .setDescription('Memory scope')
        .setRequired(true)
        .addChoices({ name: 'User', value: 'user' }, { name: 'Server', value: 'server' })
    )
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
          { name: 'Mood', value: 'mood' },
          { name: 'Lore', value: 'lore' },
          { name: 'Rule', value: 'rule' },
          { name: 'Fact', value: 'fact' },
          { name: 'Persona', value: 'persona' },
          { name: 'Other', value: 'other' }
        )
    );

  constructor(
    private db: DatabaseAdapter,
    private permissions: PermissionManager
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const memoryId = interaction.options.getString('id');
    const contextType = interaction.options.getString('type');
    const scope = interaction.options.getString('scope') || 'user';

    if (!memoryId && !contextType) {
      await interaction.editReply('Please specify either a memory ID or type to clear.');
      return;
    }

    if (scope === 'server') {
      if (!interaction.guildId || !interaction.guild) {
        await interaction.editReply('Server-scoped memory can only be cleared in a server.');
        return;
      }

      const member = await interaction.guild.members.fetch(interaction.user.id);
      const canModerate = await this.permissions.canModerate(
        interaction.guildId,
        interaction.user.id,
        member
      );

      if (!canModerate) {
        await interaction.editReply(
          'You need moderator permissions to clear server-scoped memories.'
        );
        return;
      }

      if (memoryId) {
        const memories = await this.db.getServerMemories(interaction.guildId, undefined, 200);
        const memory = memories.find(item => item.id.startsWith(memoryId));
        if (!memory) {
          await interaction.editReply(
            `No server memory found with ID starting with \`${memoryId}\`.`
          );
          return;
        }

        await this.db.deleteServerMemory(memory.id);
        await interaction.editReply(
          `Server memory \`${memory.id.slice(0, 8)}\` deleted successfully.`
        );
        return;
      }

      if (contextType) {
        const memories = await this.db.getServerMemories(interaction.guildId, contextType, 200);
        for (const memory of memories) {
          await this.db.deleteServerMemory(memory.id);
        }
        await interaction.editReply(`Deleted ${memories.length} server ${contextType} memories.`);
        return;
      }
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
