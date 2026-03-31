import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  SlashCommandBuilder
} from 'discord.js';
import { Command } from './types';
import { ProviderRegistry } from '../providers/registry';
import { QuotaMiddleware } from '../middleware/quota';
import { AdminAdapter } from '../database/admin-adapter';
import { screenExternalUrl, type UrlPolicyOptions } from '../services/url-context';

const XAI_VIDEO_MODEL = 'grok-imagine-video';
const FIXED_VIDEO_OUTPUT_COUNT = 1;

// Pricing basis from xAI: 1 quota token ~= one image-input unit ($0.002).
const IMAGE_INPUT_UNIT_PRICE_USD = 0.002;
const VIDEO_OUTPUT_PRICE_USD: Record<'480p' | '720p', number> = {
  '480p': 0.05,
  '720p': 0.07
};
const BASE_VIDEO_DURATION_SECONDS = 5;
const MAX_INLINE_VIDEO_BYTES = 24 * 1024 * 1024;

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
    private urlSecurity?: VideoUrlSecurityOptions
  ) {}

  private inferVideoExtension(url: string, contentType?: string): string {
    const lowerType = (contentType || '').toLowerCase();
    if (lowerType.includes('mp4')) return 'mp4';
    if (lowerType.includes('webm')) return 'webm';
    if (lowerType.includes('quicktime')) return 'mov';

    const pathPart = url.split('?')[0] || '';
    const ext = pathPart.split('.').pop()?.toLowerCase();
    if (ext && ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) {
      return ext;
    }

    return 'mp4';
  }

  private async buildInlineVideoAttachment(url: string): Promise<{
    attachment: AttachmentBuilder | null;
    reason?: string;
  }> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return {
          attachment: null,
          reason: `video fetch failed (${response.status})`
        };
      }

      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
      if (Number.isFinite(contentLength) && contentLength > MAX_INLINE_VIDEO_BYTES) {
        return {
          attachment: null,
          reason: 'video file is too large for inline upload'
        };
      }

      const contentType = response.headers.get('content-type') || undefined;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0) {
        return {
          attachment: null,
          reason: 'video download returned empty content'
        };
      }

      if (buffer.byteLength > MAX_INLINE_VIDEO_BYTES) {
        return {
          attachment: null,
          reason: 'video file is too large for inline upload'
        };
      }

      const extension = this.inferVideoExtension(url, contentType);
      const fileName = `video-${Date.now()}.${extension}`;
      return {
        attachment: new AttachmentBuilder(buffer, { name: fileName })
      };
    } catch (error) {
      return {
        attachment: null,
        reason: error instanceof Error ? error.message : 'unknown download error'
      };
    }
  }

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

      const result = await provider.generateVideo(prompt, {
        model: XAI_VIDEO_MODEL,
        duration,
        resolution: effectiveResolution,
        aspectRatio,
        referenceImages: references,
        count: FIXED_VIDEO_OUTPUT_COUNT
      });

      const embed = new EmbedBuilder()
        .setTitle('Video Generated')
        .setDescription(
          [
            `Prompt: ${prompt}`,
            `Model: ${result.model || XAI_VIDEO_MODEL}`,
            `Duration: ${result.duration || duration}s`,
            `Resolution: ${effectiveResolution}`,
            `References: ${references.length}`,
            `Quota Cost: ${quotaCost} video tokens`,
            `Outputs: ${FIXED_VIDEO_OUTPUT_COUNT} (fixed)`
          ].join('\n')
        )
        .setURL(result.url)
        .setFooter({
          text: 'Video URL is temporary. Save it promptly.'
        })
        .setTimestamp();

      const inlineVideo = await this.buildInlineVideoAttachment(result.url);
      if (inlineVideo.attachment) {
        await interaction.editReply({
          embeds: [embed],
          files: [inlineVideo.attachment]
        });
      } else {
        const fallbackEmbed = EmbedBuilder.from(embed).addFields({
          name: 'Video Link',
          value: result.url
        });

        await interaction.editReply({
          content: `Unable to upload video inline (${inlineVideo.reason || 'unknown reason'}).`,
          embeds: [fallbackEmbed]
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
      await interaction.editReply(
        `Error generating video: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
