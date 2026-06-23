import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter, logger } from '@silo/core';
import { ProviderRegistry } from '../../providers/registry';
import { PermissionManager } from '../../permissions/manager';
import {
  detectDeterministicIllicitContent,
  hasUnsafeSexualContext,
  hasPromptInjectionPattern
} from '../../security/content-sanitizer';
import { sentimentClassifier, shouldApplySentiment } from '../../security/sentiment-classifier';
import {
  summarizeTextForTrace,
  withLangfuseGuardrail,
  withLangfuseSpan
} from '../../telemetry/langfuse-client';
import { buildLangfuseTraceMetadata } from '../../telemetry/langfuse-metadata';

function extractLoreEntities(content: string): string[] {
  const matches = content.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g) || [];
  return [...new Set(matches.map(entity => entity.toLowerCase()))].slice(0, 12);
}

const SERVER_CONTEXT_TRUST: Record<string, number> = {
  lore: 0.92,
  rule: 0.94,
  fact: 0.86,
  persona: 0.9,
  other: 0.74
};

const SERVER_CONTEXT_PRIORITY: Record<string, number> = {
  lore: 94,
  rule: 96,
  fact: 88,
  persona: 90,
  other: 80
};

function resolveServerConflictKey(contextType: string, entities: string[]): string | null {
  if (entities.length > 0 && entities[0]) {
    return entities[0];
  }

  if (contextType === 'persona' || contextType === 'lore') {
    return 'server_identity';
  }

  return null;
}

export const serverMemorySetInternals = {
  hasPromptInjectionPattern,
  detectDeterministicIllicitContent,
  hasUnsafeSexualContext,
  extractLoreEntities,
  SERVER_CONTEXT_TRUST,
  SERVER_CONTEXT_PRIORITY,
  resolveServerConflictKey
};

export class ServerMemorySetCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('server-memory-set')
    .setDescription('Store a new memory for the server')
    .addStringOption(option =>
      option.setName('content').setDescription('The memory content to store').setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Memory type')
        .setRequired(true)
        .addChoices(
          { name: 'Lore', value: 'lore' },
          { name: 'Rule', value: 'rule' },
          { name: 'Fact', value: 'fact' },
          { name: 'Persona', value: 'persona' },
          { name: 'Other', value: 'other' }
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
    private permissions: PermissionManager,
    private registry?: ProviderRegistry
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

    const content = interaction.options.getString('content', true);
    const contextType = interaction.options.getString('type', true);
    const expiresInHours = interaction.options.getInteger('expires-in-hours');
    const traceMetadata = buildLangfuseTraceMetadata({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id,
      messageType: 'slash-command',
      commandName: 'server-memory-set'
    });

    const guardrailDecision = await withLangfuseGuardrail(
      {
        name: 'server-memory-set.input-guardrail',
        input: {
          scope: 'server',
          contextType,
          expiresInHours: expiresInHours ?? undefined,
          contentPreview: summarizeTextForTrace(content)
        },
        metadata: {
          ...traceMetadata,
          memoryScope: 'server'
        }
      },
      async guardrail => {
        if (serverMemorySetInternals.hasPromptInjectionPattern(content)) {
          guardrail?.update({
            output: {
              allowed: false,
              action: 'blocked',
              reason: 'prompt_injection'
            }
          });
          return {
            allowed: false,
            reply:
              'Memory looks like instruction override text. Please store factual context instead of control instructions.'
          };
        }

        const deterministicViolations =
          serverMemorySetInternals.detectDeterministicIllicitContent(content);
        if (deterministicViolations.length > 0) {
          guardrail?.update({
            output: {
              allowed: false,
              action: 'blocked',
              reason: 'deterministic_illicit_content',
              categories: deterministicViolations
            }
          });
          return {
            allowed: false,
            reply:
              'Memory was rejected by safety policy. Please remove unsafe content and try again.'
          };
        }

        if (serverMemorySetInternals.hasUnsafeSexualContext(content)) {
          guardrail?.update({
            output: {
              allowed: false,
              action: 'blocked',
              reason: 'unsafe_sexual_content'
            }
          });
          return {
            allowed: false,
            reply:
              'Memory was rejected by safety policy. Please remove unsafe sexual content and try again.'
          };
        }

        guardrail?.update({
          output: {
            allowed: true,
            action: 'allowed'
          }
        });
        return {
          allowed: true,
          reply: ''
        };
      }
    );

    if (!guardrailDecision.allowed) {
      await interaction.editReply(guardrailDecision.reply);
      return;
    }

    let expiresAt: Date | undefined;
    if (expiresInHours) {
      expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    }

    const entities = serverMemorySetInternals.extractLoreEntities(content);
    const normalizedContextType = contextType.toLowerCase();
    const sentiment = await sentimentClassifier.classifyPrompt(content);
    const sentimentMetadata =
      sentiment && shouldApplySentiment(sentiment)
        ? {
            sentimentLabel: sentiment.label,
            sentimentScore: sentiment.score,
            sentimentConfidence: sentiment.confidence,
            toneFlags: {
              urgency: sentiment.urgency,
              frustration: sentiment.frustration,
              confusion: sentiment.confusion
            }
          }
        : {};
    const metadata = {
      entities,
      source: 'server_moderator_command',
      sourcePriority: serverMemorySetInternals.SERVER_CONTEXT_PRIORITY[normalizedContextType] ?? 80,
      trustScore: serverMemorySetInternals.SERVER_CONTEXT_TRUST[normalizedContextType] ?? 0.74,
      verified: true,
      conflictKey: serverMemorySetInternals.resolveServerConflictKey(
        normalizedContextType,
        entities
      ),
      ...sentimentMetadata
    };

    // Generate embedding for semantic search if RAG is enabled
    const embedding = await withLangfuseSpan(
      {
        name: 'server-memory-set.embedding-generation',
        input: {
          scope: 'server',
          contextType,
          contentPreview: summarizeTextForTrace(content)
        },
        metadata: {
          ...traceMetadata,
          memoryScope: 'server'
        }
      },
      async observation => {
        if (!this.registry) {
          observation?.update({
            output: {
              generated: false,
              reason: 'provider_registry_unavailable'
            }
          });
          return undefined;
        }

        try {
          const embeddingProvider = this.registry.getEmbeddingProvider();
          const embeddings = await embeddingProvider.generateEmbeddings([content]);
          const generatedEmbedding =
            embeddings && embeddings.length > 0 && embeddings[0] ? embeddings[0] : undefined;

          observation?.update({
            output: {
              generated: Boolean(generatedEmbedding),
              vectorLength: generatedEmbedding?.length ?? 0
            }
          });

          return generatedEmbedding;
        } catch (error) {
          observation?.update({
            level: 'WARNING',
            statusMessage: error instanceof Error ? error.message : 'Unknown error',
            output: {
              generated: false,
              reason: 'embedding_generation_failed'
            }
          });
          // RAG not enabled or embedding failed - continue without embedding
          logger.debug('Embedding generation skipped for memory:', error);
          return undefined;
        }
      }
    );

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

    logger.info(
      `Memory created: scope=server, id=${memory.id}, guild=${interaction.guildId}, actor=${interaction.user.id}, type=${contextType}, entities=${metadata.entities.length}, embedding=${embedding ? 'yes' : 'no'}`
    );

    const expiresText = expiresAt
      ? ` (expires <t:${Math.floor(expiresAt.getTime() / 1000)}:R>)`
      : '';
    const ragStatus = embedding ? ' 🔍' : '';

    await interaction.editReply(
      `Server memory stored successfully!${ragStatus}\n**Type:** ${contextType}\n**ID:** \`${memory.id}\`${expiresText}`
    );
  }
}
