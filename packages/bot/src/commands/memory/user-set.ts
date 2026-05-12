import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { DatabaseAdapter, UserMemory, logger } from '@silo/core';
import { ProviderRegistry } from '../../providers/registry';
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

export const userMemorySetInternals = {
  hasPromptInjectionPattern,
  detectDeterministicIllicitContent,
  hasUnsafeSexualContext,
  extractLoreEntities,
  USER_CONTEXT_TRUST,
  resolveUserConflictKey
};

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
    const traceMetadata = buildLangfuseTraceMetadata({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id,
      messageType: 'slash-command',
      commandName: 'user-memory-set'
    });

    const guardrailDecision = await withLangfuseGuardrail(
      {
        name: 'user-memory-set.input-guardrail',
        input: {
          scope: 'user',
          contextType,
          expiresInHours: expiresInHours ?? undefined,
          contentPreview: summarizeTextForTrace(content)
        },
        metadata: {
          ...traceMetadata,
          memoryScope: 'user'
        }
      },
      async guardrail => {
        if (userMemorySetInternals.hasPromptInjectionPattern(content)) {
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
          userMemorySetInternals.detectDeterministicIllicitContent(content);
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

        if (userMemorySetInternals.hasUnsafeSexualContext(content)) {
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

    const entities = userMemorySetInternals.extractLoreEntities(content);
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
      source: 'user_command',
      sourcePriority: 62,
      trustScore: userMemorySetInternals.USER_CONTEXT_TRUST[contextType],
      conflictKey: userMemorySetInternals.resolveUserConflictKey(contextType, entities),
      ...sentimentMetadata
    };

    // Generate embedding for semantic search if RAG is enabled
    const embedding = await withLangfuseSpan(
      {
        name: 'user-memory-set.embedding-generation',
        input: {
          scope: 'user',
          contextType,
          contentPreview: summarizeTextForTrace(content)
        },
        metadata: {
          ...traceMetadata,
          memoryScope: 'user'
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
