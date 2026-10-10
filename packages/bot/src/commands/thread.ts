import { toLangfuseUsage } from '../telemetry/langfuse-usage';
import {
  ChatInputCommandInteraction,
  GuildMember,
  SlashCommandBuilder,
  ChannelType,
  ThreadAutoArchiveDuration
} from 'discord.js';
import { summarizeTextForTrace, withLangfuseGeneration } from '../telemetry/langfuse-client';
import { buildLangfuseTags, buildLangfuseTraceMetadata } from '../telemetry/langfuse-metadata';
import { Command } from './types';
import { DatabaseAdapter } from '@silo/core';
import { ProviderRegistry } from '../providers/registry';
import { sanitizeDiscordMassMentions } from '../security/output-sanitizer';
import { evaluateSafetyDecision } from '../security/safety-decision';
import type { QuotaMiddleware } from '../middleware/quota';

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
    private quota?: QuotaMiddleware,
    private shutdownSignal?: AbortSignal,
    private resolvePromptHash?: (guildId: string) => Promise<string>
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(60_000),
      ...(this.shutdownSignal ? [this.shutdownSignal] : [])
    ]);
    signal.throwIfAborted();
    await interaction.deferReply();

    if (
      !interaction.guildId ||
      !interaction.channel ||
      interaction.channel.type !== ChannelType.GuildText
    ) {
      await interaction.editReply('This command can only be used in text channels.');
      return;
    }

    const fallbackThreadName = `Chat with ${interaction.user.username}`;

    let threadName = interaction.options.getString('name');

    // AI-generate thread name if not provided
    if (!threadName) {
      if (!this.resolvePromptHash) throw new Error('Thread prompt resolution is unavailable');
      const promptHash = await this.resolvePromptHash(interaction.guildId);
      signal.throwIfAborted();
      // Reuse only eligible context scoped to the requester and channel.
      const { messages: history } = await this.db.getPromptContext({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        requesterUserId: interaction.user.id,
        promptHash,
        maxTurns: 5
      });
      signal.throwIfAborted();
      if (history.length > 0) {
        if (
          !this.quota ||
          !(interaction.member instanceof GuildMember) ||
          interaction.member.id !== interaction.user.id ||
          interaction.member.guild.id !== interaction.guildId
        ) {
          throw new Error('Summary quota admission is unavailable');
        }
        signal.throwIfAborted();
        const textRoute = this.registry.getTextRoute('summary', undefined, {
          middleware: this.quota,
          operationKey: `discord:${interaction.id}:thread`,
          guildId: interaction.guildId!,
          userId: interaction.user.id,
          member: interaction.member,
          usageType: 'text_tokens'
        });
        textRoute.options.signal = signal;
        const provider = textRoute.provider;
        const requestedModel = textRoute.options.model;
        const context = history
          .map(m => m.content)
          .join('\n')
          .slice(0, 4000);
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
              { ...textRoute.options, maxTokens: 20 }
            );

            generation?.update({
              model: providerResponse.model || requestedModel || provider.name,
              usageDetails: toLangfuseUsage(providerResponse.usage),
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
        signal.throwIfAborted();
        if (threadName) {
          const safety = await evaluateSafetyDecision(threadName, {
            stage: 'assistant_output',
            source: 'thread_name',
            guildId: interaction.guildId,
            userId: interaction.user.id,
            failurePolicy: 'fail_closed',
            signal
          });
          signal.throwIfAborted();
          if (safety.failed || safety.action !== 'allow') {
            await interaction.editReply(
              safety.failed
                ? 'Thread name generation is temporarily unavailable. Please provide a name or try again shortly.'
                : 'I could not safely generate a thread name. Please provide a name.'
            );
            return;
          }
        }
        if (!threadName) {
          threadName = fallbackThreadName;
        }
      } else {
        threadName = fallbackThreadName;
      }
    }

    signal.throwIfAborted();
    // Create thread
    const thread = await interaction.channel.threads.create({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: `Created by ${interaction.user.tag}`
    });

    // An in-flight create may complete after cancellation; suppress subsequent sends.
    signal.throwIfAborted();
    await interaction.editReply({
      content: `Created thread: ${thread.toString()}`,
      allowedMentions: { parse: [] }
    });
    signal.throwIfAborted();
    await thread.send(
      `Thread created! I'll respond to all messages here automatically (no need to @ me).`
    );
  }
}
