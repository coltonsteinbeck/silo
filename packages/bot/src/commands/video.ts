import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from 'discord.js';
import { logger } from '@silo/core';
import { Command } from './types';
import { ProviderRegistry } from '../providers/registry';
import { QuotaMiddleware } from '../middleware/quota';
import { AdminAdapter } from '../database/admin-adapter';
import { screenExternalUrl, type UrlPolicyOptions } from '../services/url-context';
import {
  moderateCommandPrompt,
  type PromptModerationGuard
} from '../security/command-prompt-moderation';
import { buildMediaReplyPayload } from '../services/media-delivery';
import { withLangfuseGeneration, summarizeTextForTrace } from '../telemetry/langfuse-client';
import { buildLangfuseTags, buildLangfuseTraceMetadata } from '../telemetry/langfuse-metadata';

const XAI_VIDEO_MODEL = 'grok-imagine-video';

// Pricing basis from xAI: 1 quota token ~= one image-input unit ($0.002).
const IMAGE_INPUT_UNIT_PRICE_USD = 0.002;
const VIDEO_OUTPUT_PRICE_USD: Record<'480p' | '720p', number> = {
  '480p': 0.05,
  '720p': 0.07
};
const BASE_VIDEO_DURATION_SECONDS = 5;

interface VideoUrlSecurityOptions {
  policy?: UrlPolicyOptions;
  adminDb?: AdminAdapter;
}

function calculateVideoQuotaCost(
  duration: number,
  resolution: string,
  referenceCount: number
): number {
  const normalizedResolution: '480p' | '720p' = resolution === '720p' ? '720p' : '480p';
  const safeDuration = Math.max(1, duration);
  const outputUsd =
    VIDEO_OUTPUT_PRICE_USD[normalizedResolution] * (safeDuration / BASE_VIDEO_DURATION_SECONDS);
  const referenceUsd = Math.max(0, referenceCount) * IMAGE_INPUT_UNIT_PRICE_USD;
  const totalUsd = outputUsd + referenceUsd;

  // Convert USD-estimated media cost to internal token units.
  return Math.max(1, Math.ceil(totalUsd / IMAGE_INPUT_UNIT_PRICE_USD));
}

export class VideoCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('video')
    .setDescription('Generate a single video with xAI grok-imagine-video')
    .addStringOption(option =>
      option.setName('prompt').setDescription('Video prompt').setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('duration')
        .setDescription('Video length in seconds')
        .setRequired(false)
        .addChoices(
          { name: '5 seconds', value: 5 },
          { name: '8 seconds', value: 8 },
          { name: '10 seconds', value: 10 }
        )
    )
    .addStringOption(option =>
      option
        .setName('resolution')
        .setDescription('Video resolution')
        .setRequired(false)
        .addChoices({ name: '480p', value: '480p' }, { name: '720p', value: '720p' })
    )
    .addStringOption(option =>
      option
        .setName('aspect-ratio')
        .setDescription('Video aspect ratio')
        .setRequired(false)
        .addChoices(
          { name: '16:9', value: '16:9' },
          { name: '9:16', value: '9:16' },
          { name: '1:1', value: '1:1' }
        )
    )
    .addAttachmentOption(option =>
      option.setName('reference1').setDescription('Reference image 1').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('reference2').setDescription('Reference image 2').setRequired(false)
    );

  constructor(
    private registry: ProviderRegistry,
    private quotaMiddleware?: QuotaMiddleware,
    private urlSecurity?: VideoUrlSecurityOptions,
    private promptGuard: PromptModerationGuard = moderateCommandPrompt
  ) {}

  private async logUrlScreening(
    interaction: ChatInputCommandInteraction,
    payload: {
      url: string;
      domain: string;
      action: 'allowed' | 'blocked' | 'skipped';
      reason: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.urlSecurity?.adminDb || !interaction.guildId) {
      return;
    }

    await this.urlSecurity.adminDb.logUrlSecurityEvent({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      url: payload.url,
      domain: payload.domain,
      action: payload.action,
      reason: payload.reason,
      metadata: payload.metadata
    });
  }

  private async collectReferenceImages(
    interaction: ChatInputCommandInteraction
  ): Promise<{ valid: boolean; references: string[]; reason?: string }> {
    const references: string[] = [];
    const getAttachment = interaction.options.getAttachment?.bind(interaction.options);

    if (!getAttachment) {
      return { valid: true, references };
    }

    for (const key of ['reference1', 'reference2'] as const) {
      const attachment = getAttachment(key);
      if (!attachment) {
        continue;
      }

      if (!attachment.contentType?.startsWith('image/')) {
        return {
          valid: false,
          references: [],
          reason: `Attachment ${key} is not an image.`
        };
      }

      references.push(attachment.url);
    }

    for (const ref of references) {
      const screening = await screenExternalUrl(ref, {
        policy: this.urlSecurity?.policy
      });

      await this.logUrlScreening(interaction, {
        url: ref,
        domain: screening.domain,
        action: screening.allowed ? 'allowed' : 'blocked',
        reason: screening.reason
      });

      if (!screening.allowed) {
        return {
          valid: false,
          references: [],
          reason: `Reference URL blocked (${screening.reason}).`
        };
      }
    }

    return { valid: true, references };
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const prompt = interaction.options.getString('prompt', true);
    const duration = interaction.options.getInteger('duration') || 8;
    const resolution = interaction.options.getString('resolution') || '480p';
    const aspectRatio = interaction.options.getString('aspect-ratio') || '16:9';

    const promptDecision = await this.promptGuard({
      prompt,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      command: 'video',
      phase: 'generate'
    });

    if (!promptDecision.allowed) {
      await interaction.reply({
        content: promptDecision.userMessage || '⚠️ Prompt blocked by content policy.',
        ephemeral: true
      });
      return;
    }

    const effectivePrompt = promptDecision.processedPrompt;

    const refsResult = await this.collectReferenceImages(interaction);
    if (!refsResult.valid) {
      await interaction.reply({
        content: `Unable to process references: ${refsResult.reason}`,
        ephemeral: true
      });
      return;
    }

    const references = refsResult.references;
    const effectiveResolution = resolution;
    const quotaReferenceCount = references.length;
    const quotaCost = calculateVideoQuotaCost(duration, effectiveResolution, quotaReferenceCount);

    if (this.quotaMiddleware && interaction.guildId) {
      const member = interaction.member as GuildMember;
      const quotaCheck = await this.quotaMiddleware.checkQuota(
        interaction.guildId,
        interaction.user.id,
        member,
        'video_tokens',
        quotaCost
      );

      if (!quotaCheck.allowed) {
        await interaction.reply({
          content: `⚠️ ${quotaCheck.reason}`,
          ephemeral: true
        });
        return;
      }
    }

    await interaction.deferReply();

    try {
      const provider = this.registry.getVideoProvider('xai');
      if (!provider) {
        await interaction.editReply('No video provider configured for grok-imagine-video.');
        return;
      }

      const generationMetadataInput = {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        interactionId: interaction.id,
        messageType: 'slash-command' as const,
        commandName: 'video',
        provider: provider.name,
        model: XAI_VIDEO_MODEL,
        adapter: provider.name,
        usesTools: false,
        supportsImages: references.length > 0,
        supportsVideo: true,
        supportsAudio: false,
        isLocalModel: provider.name === 'local'
      };

      const result = await withLangfuseGeneration(
        {
          name: 'slash-command-video',
          tags: buildLangfuseTags(generationMetadataInput),
          input: {
            promptPreview: summarizeTextForTrace(effectivePrompt),
            duration,
            resolution: effectiveResolution,
            aspectRatio,
            referenceCount: references.length,
            quotaCost
          },
          model: XAI_VIDEO_MODEL,
          metadata: buildLangfuseTraceMetadata(generationMetadataInput)
        },
        async generation => {
          const providerResult = await provider.generateVideo(effectivePrompt, {
            model: XAI_VIDEO_MODEL,
            duration,
            resolution: effectiveResolution,
            aspectRatio,
            referenceImages: references
          });

          generation?.update({
            model: providerResult.model || XAI_VIDEO_MODEL,
            output: {
              hasContent: Boolean(providerResult.url),
              duration: providerResult.duration || duration,
              moderationPassed: providerResult.moderationPassed ?? true
            },
            metadata: buildLangfuseTraceMetadata({
              ...generationMetadataInput,
              model: providerResult.model || XAI_VIDEO_MODEL
            })
          });

          return providerResult;
        }
      );

      const inlineVideo = await buildMediaReplyPayload({
        kind: 'video',
        url: result.url,
        model: result.model || XAI_VIDEO_MODEL,
        prompt: effectivePrompt,
        moderationPassed: result.moderationPassed
      });
      if (inlineVideo.uploaded) {
        await interaction.editReply({
          embeds: [],
          files: inlineVideo.files
        });
      } else {
        logger.warn('Video inline upload unavailable', {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          reason: inlineVideo.failureReason,
          mediaUrl: result.url
        });
        await interaction.editReply({
          content:
            inlineVideo.content || 'Could not upload video inline. Please try again in a moment.',
          embeds: []
        });
      }

      if (this.quotaMiddleware && interaction.guildId) {
        await this.quotaMiddleware.recordUsage(
          interaction.guildId,
          interaction.user.id,
          'video_tokens',
          quotaCost
        );
      }
    } catch (error) {
      logger.error('Video generation failed', {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        error
      });
      await interaction.editReply('Video generation failed. Please try again in a moment.');
    }
  }
}
