import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter, UserMemory, logger } from '@silo/core';
import { ProviderRegistry } from '../../providers/registry';
import {
  detectDeterministicIllicitContent,
  hasPromptInjectionPattern
} from '../../security/content-sanitizer';

function extractLoreEntities(content: string): string[] {
  const matches = content.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g) || [];
  return [...new Set(matches.map(entity => entity.toLowerCase()))].slice(0, 12);
}

const USER_CONTEXT_TRUST: Record<UserMemory['contextType'], number> = {
  conversation: 0.58,
  preference: 0.82,
  summary: 0.68,
  temporary: 0.45,
  mood: 0.78
};

function resolveUserConflictKey(
  contextType: UserMemory['contextType'],
  entities: string[]
): string | null {
  if (entities.length > 0 && entities[0]) {
    return entities[0];
  }

  if (contextType === 'preference' || contextType === 'mood') {
    return `user_${contextType}`;
  }

  return null;
}

export class UserMemorySetCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('user-memory-set')
    .setDescription('Store a new memory for yourself')
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const content = interaction.options.getString('content', true);
    const contextType = interaction.options.getString('type', true) as UserMemory['contextType'];
    const expiresInHours = interaction.options.getInteger('expires-in-hours');

    const deterministicViolations = detectDeterministicIllicitContent(content);
    if (deterministicViolations.length > 0) {
      await interaction.editReply(
        'Memory was rejected by safety policy. Please remove unsafe content and try again.'
      );
      return;
    }

    if (hasPromptInjectionPattern(content)) {
      await interaction.editReply(
        'Memory looks like instruction override text. Please store factual context instead of control instructions.'
      );
      return;
    }

    let expiresAt: Date | undefined;
    if (expiresInHours) {
      expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    }

    const entities = extractLoreEntities(content);
    const metadata = {
      entities,
      source: 'user_command',
      sourcePriority: 62,
      trustScore: USER_CONTEXT_TRUST[contextType],
      conflictKey: resolveUserConflictKey(contextType, entities)
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

    logger.info(
      `Memory created: scope=user, id=${memory.id}, actor=${interaction.user.id}, type=${contextType}, entities=${metadata.entities.length}, embedding=${embedding ? 'yes' : 'no'}`
    );

    const expiresText = expiresAt
      ? ` (expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>)`
      : '';
    const ragStatus = embedding ? ' 🔍' : '';

    await interaction.editReply(
      `User memory stored successfully!${ragStatus}\n**Type:** ${contextType}\n**ID:** \`${memory.id}\`${expiresText}`
    );
  }
}
