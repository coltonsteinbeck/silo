import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ChannelType,
  ThreadAutoArchiveDuration
} from 'discord.js';
import { summarizeTextForTrace, withLangfuseGeneration } from '../telemetry/langfuse-client';
import { buildLangfuseTags, buildLangfuseTraceMetadata } from '../telemetry/langfuse-metadata';
import { Command } from './types';
import { DatabaseAdapter } from '@silo/core';
import { ProviderRegistry } from '../providers/registry';
import { AdminAdapter } from '../database/admin-adapter';
import { sanitizeDiscordMassMentions } from '../security/output-sanitizer';

export class ThreadCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('thread')
    .setDescription('Create a dedicated conversation thread')
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Thread name (AI will auto-generate if not provided)')
        .setRequired(false)
    );

  constructor(
    private db: DatabaseAdapter,
    private registry: ProviderRegistry,
    private adminDb?: AdminAdapter
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.editReply('This command can only be used in text channels.');
      return;
    }

    const fallbackThreadName = `Chat with ${interaction.user.username}`;

    let threadName = interaction.options.getString('name');

    // AI-generate thread name if not provided
    if (!threadName) {
      // For thread naming, we just need recent messages from this channel
      const history = await this.db.getConversationHistory(interaction.channelId, 'default', 5);
      if (history.length > 0) {
        // Get guild's preferred provider
        let preferredProvider: string | undefined;
        if (this.adminDb && interaction.guildId) {
          const serverConfig = await this.adminDb.getServerConfig(interaction.guildId);
          preferredProvider = serverConfig?.defaultProvider || undefined;
        }

        const provider = this.registry.getTextProvider(preferredProvider);
        const requestedModel = this.registry.getConfiguredTextModel(provider.name);
        const context = history.map(m => m.content).join('\n');
        const generationMetadataInput = {
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          interactionId: interaction.id,
          messageType: 'slash-command' as const,
          commandName: 'thread',
          provider: provider.name,
          model: requestedModel,
          adapter: provider.name,
          hasConversationHistory: history.length > 0,
          conversationMessageCount: history.length,
          usesTools: false,
          supportsImages: Boolean(provider.capabilities?.vision),
          supportsVideo: Boolean(provider.capabilities?.videoGeneration),
          supportsAudio: false,
          isLocalModel: provider.name === 'local'
        };

        const response = await withLangfuseGeneration(
          {
            name: 'slash-command-thread-name',
            tags: buildLangfuseTags(generationMetadataInput),
            input: {
              historyMessageCount: history.length,
              contextPreview: summarizeTextForTrace(context)
            },
            model: requestedModel || provider.name,
            modelParameters: {
              maxTokens: 20
            },
            metadata: buildLangfuseTraceMetadata(generationMetadataInput)
          },
          async generation => {
            const providerResponse = await provider.generateText(
              [
                {
                  role: 'system',
                  content:
                    'Generate a short, descriptive thread name (2-4 words) based on the conversation context. Only respond with the name, no quotes or punctuation.'
                },
                {
                  role: 'user',
                  content: `Context:\n${context}`
                }
              ],
              { maxTokens: 20 }
            );

            generation?.update({
              model: providerResponse.model || requestedModel || provider.name,
              usageDetails: providerResponse.usage,
              output: {
                outputCharacters: providerResponse.content.length,
                hasContent: Boolean(providerResponse.content.trim())
              },
              metadata: buildLangfuseTraceMetadata({
                ...generationMetadataInput,
                model: providerResponse.model || requestedModel || provider.name
              })
            });

            return providerResponse;
          }
        );

        threadName = sanitizeDiscordMassMentions(response.content).trim().slice(0, 100);
        if (!threadName) {
          threadName = fallbackThreadName;
        }
      } else {
        threadName = fallbackThreadName;
      }
    }

    // Create thread
    const thread = await interaction.channel.threads.create({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: `Created by ${interaction.user.tag}`
    });

    await interaction.editReply(`Created thread: ${thread.toString()}`);
    await thread.send(
      `Thread created! I'll respond to all messages here automatically (no need to @ me).`
    );
  }
}
