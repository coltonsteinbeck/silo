import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter, UserMemory, logger } from '@silo/core';
import { ProviderRegistry } from '../../providers/registry';
import { PermissionManager } from '../../permissions/manager';

function extractLoreEntities(content: string): string[] {
  const matches = content.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g) || [];
  return [...new Set(matches.map(entity => entity.toLowerCase()))].slice(0, 12);
}

export class SetMemoryCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('memory-set')
    .setDescription('Store a new memory')
    .addStringOption(option =>
      option.setName('content').setDescription('The memory content to store').setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Memory type')
        .setRequired(true)
        .addChoices(
          { name: 'Conversation', value: 'conversation' },
          { name: 'Preference', value: 'preference' },
          { name: 'Summary', value: 'summary' },
          { name: 'Temporary', value: 'temporary' },
          { name: 'Mood', value: 'mood' }
        )
    )
    .addStringOption(option =>
      option
        .setName('scope')
        .setDescription('Memory scope')
        .setRequired(false)
        .addChoices({ name: 'User', value: 'user' }, { name: 'Server', value: 'server' })
    )
    .addIntegerOption(
      option =>
        option
          .setName('expires-in-hours')
          .setDescription('Hours until memory expires (optional)')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(8760) // 1 year
    );

  constructor(
    private db: DatabaseAdapter,
    private permissions: PermissionManager,
    private registry?: ProviderRegistry
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const content = interaction.options.getString('content', true);
    const contextType = interaction.options.getString('type', true) as UserMemory['contextType'];
    const scope = interaction.options.getString('scope') || 'user';
    const expiresInHours = interaction.options.getInteger('expires-in-hours');

    let expiresAt: Date | undefined;
    if (expiresInHours) {
      expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    }

    const metadata = {
      entities: extractLoreEntities(content)
    };

    // Generate embedding for semantic search if RAG is enabled
    let embedding: number[] | undefined;
    try {
      if (this.registry) {
        const embeddingProvider = this.registry.getEmbeddingProvider();
        const embeddings = await embeddingProvider.generateEmbeddings([content]);
        if (embeddings && embeddings.length > 0 && embeddings[0]) {
          embedding = embeddings[0];
        }
      }
    } catch (error) {
      // RAG not enabled or embedding failed - continue without embedding
      logger.debug('Embedding generation skipped for memory:', error);
    }

    if (scope === 'server') {
      if (!interaction.guildId || !interaction.guild) {
        await interaction.editReply('Server-scoped memory can only be used in a server.');
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
          'You need moderator permissions to store server-scoped memories.'
        );
        return;
      }

      const memory = await this.db.storeServerMemory(
        {
          serverId: interaction.guildId,
          userId: interaction.user.id,
          title: content.slice(0, 60),
          memoryContent: content,
          contextType,
          metadata,
          expiresAt
        },
        embedding
      );

      const expiresText = expiresAt
        ? ` (expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>)`
        : '';
      const ragStatus = embedding ? ' 🔍' : '';

      await interaction.editReply(
        `Server memory stored successfully!${ragStatus}\n**Type:** ${contextType}\n**ID:** \`${memory.id}\`${expiresText}`
      );
      return;
    }

    const memory = await this.db.storeUserMemory(
      {
        userId: interaction.user.id,
        memoryContent: content,
        contextType,
        metadata,
        expiresAt
      },
      embedding
    );

    const expiresText = expiresAt
      ? ` (expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>)`
      : '';
    const ragStatus = embedding ? ' 🔍' : '';

    await interaction.editReply(
      `Memory stored successfully!${ragStatus}\\n**Type:** ${contextType}\\n**ID:** \`${memory.id}\`${expiresText}`
    );
  }
}
