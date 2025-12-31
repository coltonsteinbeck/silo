import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter, UserMemory, logger } from '@silo/core';
import { ProviderRegistry } from '../../providers/registry';

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
    private registry?: ProviderRegistry
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const content = interaction.options.getString('content', true);
    const contextType = interaction.options.getString('type', true) as UserMemory['contextType'];
    const expiresInHours = interaction.options.getInteger('expires-in-hours');

    let expiresAt: Date | undefined;
    if (expiresInHours) {
      expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    }

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

    const memory = await this.db.storeUserMemory(
      {
        userId: interaction.user.id,
        memoryContent: content,
        contextType,
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
