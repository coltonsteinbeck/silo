import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  ModalBuilder,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { Command } from './types';
import { ProviderRegistry } from '../providers/registry';
import { QuotaMiddleware } from '../middleware/quota';
import { AdminAdapter } from '../database/admin-adapter';
import { screenExternalUrl, type UrlPolicyOptions } from '../services/url-context';

const DRAW_MODEL_CONFIG = {
  'gpt-image-1': {
    provider: 'openai',
    maxReferences: 2,
    supportsQuality: true,
    supportsSize: true,
    supportsAspectRatio: false,
    supportsResolution: false
  },
  'grok-imagine-image': {
    provider: 'xai',
    maxReferences: 2,
    supportsQuality: false,
    supportsSize: false,
    supportsAspectRatio: true,
    supportsResolution: true
  },
  'gemini-3.1-flash-image-preview': {
    provider: 'google',
    maxReferences: 3,
    supportsQuality: false,
    supportsSize: false,
    supportsAspectRatio: true,
    supportsResolution: true
  }
} as const;

type DrawModelName = keyof typeof DRAW_MODEL_CONFIG;

interface DrawSession {
  id: string;
  userId: string;
  channelId: string;
  messageId: string;
  createdAt: number;
  prompt: string;
  model: DrawModelName;
  size: string;
  quality: string;
  aspectRatio: string;
  resolution: string;
  references: string[];
  quotaCost: number;
}

interface DrawGeneration {
  embed: EmbedBuilder;
  files: AttachmentBuilder[];
}

interface DrawUrlSecurityOptions {
  policy?: UrlPolicyOptions;
  adminDb?: AdminAdapter;
}

const DRAW_SESSION_TTL_MS = 30 * 60 * 1000;

export class DrawCommand implements Command {
  private sessions = new Map<string, DrawSession>();

  data = new SlashCommandBuilder()
    .setName('draw')
    .setDescription('Generate or edit images with multiple image models')
    .addStringOption(option =>
      option.setName('prompt').setDescription('Image description').setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('model')
        .setDescription('Image model')
        .setRequired(false)
        .addChoices(
          { name: 'OpenAI GPT Image 1', value: 'gpt-image-1' },
          { name: 'xAI Grok Imagine Image', value: 'grok-imagine-image' },
          { name: 'Google Nano Banana', value: 'gemini-3.1-flash-image-preview' }
        )
    )
    .addStringOption(option =>
      option
        .setName('size')
        .setDescription('OpenAI image dimensions')
        .setRequired(false)
        .addChoices(
          { name: '1024x1024 (Square)', value: '1024x1024' },
          { name: '1536x1024 (Landscape)', value: '1536x1024' },
          { name: '1024x1536 (Portrait)', value: '1024x1536' }
        )
    )
    .addStringOption(option =>
      option
        .setName('quality')
        .setDescription('OpenAI render quality')
        .setRequired(false)
        .addChoices(
          { name: 'Auto', value: 'auto' },
          { name: 'High', value: 'high' },
          { name: 'Medium', value: 'medium' },
          { name: 'Low', value: 'low' }
        )
    )
    .addStringOption(option =>
      option
        .setName('aspect-ratio')
        .setDescription('Aspect ratio (xAI / Google)')
        .setRequired(false)
        .addChoices(
          { name: '1:1', value: '1:1' },
          { name: '16:9', value: '16:9' },
          { name: '9:16', value: '9:16' },
          { name: '3:2', value: '3:2' },
          { name: '2:3', value: '2:3' },
          { name: '4:3', value: '4:3' },
          { name: '3:4', value: '3:4' }
        )
    )
    .addStringOption(option =>
      option
        .setName('resolution')
        .setDescription('Resolution (xAI / Google)')
        .setRequired(false)
        .addChoices({ name: '1K', value: '1k' }, { name: '2K', value: '2k' })
    )
    .addAttachmentOption(option =>
      option.setName('reference1').setDescription('Reference image 1').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('reference2').setDescription('Reference image 2').setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('reference3').setDescription('Reference image 3').setRequired(false)
    );

  constructor(
    private registry: ProviderRegistry,
    private quotaMiddleware?: QuotaMiddleware,
    private urlSecurity?: DrawUrlSecurityOptions
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

  private cleanupSessions(): void {
    const cutoff = Date.now() - DRAW_SESSION_TTL_MS;
    for (const [id, session] of this.sessions.entries()) {
      if (session.createdAt < cutoff) {
        this.sessions.delete(id);
      }
    }
  }

  private createControls(sessionId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`draw_regen:${sessionId}`)
        .setLabel('Regenerate')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`draw_edit:${sessionId}`)
        .setLabel('Edit Prompt')
        .setStyle(ButtonStyle.Secondary)
    );
  }

  private formatImageError(
    error: unknown,
    context: 'generation' | 'regeneration' | 'edit'
  ): string {
    const rawMessage = error instanceof Error ? error.message : 'Unknown error';
    const lowered = rawMessage.toLowerCase();

    if (lowered.includes('content moderation') || lowered.includes('moderation')) {
      return `xAI blocked this ${context} due to content moderation. Try rephrasing with safer wording and fewer sensitive details.`;
    }

    return rawMessage;
  }

  private resolveModel(raw: string | null): DrawModelName {
    if (!raw) {
      return 'gpt-image-1';
    }

    // Backward compatibility for older command payloads/sessions.
    if (raw === 'gpt-image-1.5') {
      return 'gpt-image-1';
    }

    if (raw in DRAW_MODEL_CONFIG) {
      return raw as DrawModelName;
    }

    return 'gpt-image-1';
  }

  private calculateQuotaCost(args: {
    model: DrawModelName;
    quality: string;
    resolution: string;
    referenceCount: number;
  }): number {
    const base = args.model === 'gpt-image-1' ? 1 : 2;
    const qualityBoost = args.quality === 'high' ? 1 : 0;
    const resolutionBoost = args.resolution.toLowerCase() === '2k' ? 1 : 0;
    const referenceBoost = Math.min(args.referenceCount, 2);
    return base + qualityBoost + resolutionBoost + referenceBoost;
  }

  private async validateReferences(
    references: string[],
    model: DrawModelName,
    interaction: ChatInputCommandInteraction
  ): Promise<{ valid: boolean; reason?: string }> {
    const config = DRAW_MODEL_CONFIG[model];

    if (references.length > config.maxReferences) {
      return {
        valid: false,
        reason: `Model ${model} supports up to ${config.maxReferences} reference images.`
      };
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
          reason: `Reference URL blocked (${screening.reason}).`
        };
      }
    }

    return { valid: true };
  }

  private collectReferenceImages(interaction: ChatInputCommandInteraction): string[] {
    const references: string[] = [];
    const getAttachment = interaction.options.getAttachment?.bind(interaction.options);

    if (!getAttachment) {
      return references;
    }

    for (const key of ['reference1', 'reference2', 'reference3'] as const) {
      const attachment = getAttachment(key);
      if (!attachment) {
        continue;
      }

      const hasImageContentType = attachment.contentType?.startsWith('image/') === true;
      let hasImageExtension = false;

      if (!hasImageContentType) {
        try {
          const pathname = new URL(attachment.url).pathname.toLowerCase();
          hasImageExtension = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(pathname);
        } catch {
          hasImageExtension = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(attachment.url);
        }
      }

      if (!hasImageContentType && !hasImageExtension) {
        continue;
      }

      references.push(attachment.url);
    }

    return references;
  }

  private async generateImage(session: {
    prompt: string;
    model: DrawModelName;
    size: string;
    quality: string;
    aspectRatio: string;
    resolution: string;
    references: string[];
  }): Promise<DrawGeneration> {
    const modelConfig = DRAW_MODEL_CONFIG[session.model];
    const provider = this.registry.getImageProvider(modelConfig.provider);
    if (!provider) {
      throw new Error('No image generation provider configured. Check your environment settings.');
    }

    const options = {
      model: session.model,
      quality: modelConfig.supportsQuality ? session.quality : undefined,
      size: modelConfig.supportsSize ? session.size : undefined,
      aspectRatio: modelConfig.supportsAspectRatio ? session.aspectRatio : undefined,
      resolution: modelConfig.supportsResolution ? session.resolution : undefined,
      referenceImages: session.references,
      action: session.references.length > 0 ? ('edit' as const) : ('generate' as const),
      inputFidelity: session.references.length > 0 ? ('high' as const) : ('low' as const)
    };

    const result = await provider.generateImage(session.prompt, options);

    const files: AttachmentBuilder[] = [];
    let imageUrl = result.url;

    if (result.url.startsWith('data:image/')) {
      const parts = result.url.split(',');
      const base64Data = parts[1];
      if (!base64Data) {
        throw new Error('Invalid image response data');
      }
      const buffer = Buffer.from(base64Data, 'base64');
      const fileName = 'draw-output.png';
      files.push(new AttachmentBuilder(buffer, { name: fileName }));
      imageUrl = `attachment://${fileName}`;
    }

    const embed = new EmbedBuilder()
      .setTitle('Image Generated')
      .setDescription(
        [
          `Prompt: ${result.revisedPrompt || session.prompt}`,
          `Model: ${session.model}`,
          session.references.length > 0
            ? `References: ${session.references.length}`
            : 'References: none',
          modelConfig.supportsResolution
            ? `Resolution: ${session.resolution.toUpperCase()}`
            : `Size: ${session.size}`
        ].join('\n')
      )
      .setImage(imageUrl)
      .setFooter({
        text: 'Use buttons below to regenerate or edit prompt'
      })
      .setTimestamp();

    return { embed, files };
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    this.cleanupSessions();

    const prompt = interaction.options.getString('prompt', true);
    const model = this.resolveModel(interaction.options.getString('model'));
    const size = interaction.options.getString('size') || '1024x1024';
    const quality = interaction.options.getString('quality') || 'auto';
    const aspectRatio = interaction.options.getString('aspect-ratio') || '1:1';
    const resolution = interaction.options.getString('resolution') || '1k';
    const references = this.collectReferenceImages(interaction);

    const referenceValidation = await this.validateReferences(references, model, interaction);
    if (!referenceValidation.valid) {
      await interaction.reply({
        content: `Unable to process references: ${referenceValidation.reason}`,
        ephemeral: true
      });
      return;
    }

    const quotaCost = this.calculateQuotaCost({
      model,
      quality,
      resolution,
      referenceCount: references.length
    });

    if (this.quotaMiddleware && interaction.guildId) {
      const member = interaction.member as GuildMember;
      const quotaCheck = await this.quotaMiddleware.checkQuota(
        interaction.guildId,
        interaction.user.id,
        member,
        'images',
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
      const generation = await this.generateImage({
        prompt,
        model,
        size,
        quality,
        aspectRatio,
        resolution,
        references
      });

      const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const controls = this.createControls(sessionId);

      const responseMessage = await interaction.editReply({
        embeds: [generation.embed],
        files: generation.files,
        components: [controls]
      });

      this.sessions.set(sessionId, {
        id: sessionId,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        messageId: responseMessage.id,
        createdAt: Date.now(),
        prompt,
        model,
        size,
        quality,
        aspectRatio,
        resolution,
        references,
        quotaCost
      });

      if (this.quotaMiddleware && interaction.guildId) {
        await this.quotaMiddleware.recordUsage(
          interaction.guildId,
          interaction.user.id,
          'images',
          quotaCost
        );
      }
    } catch (error) {
      await interaction.editReply(
        `Error generating image: ${this.formatImageError(error, 'generation')}`
      );
    }
  }

  async handleButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith('draw_')) {
      return false;
    }

    this.cleanupSessions();

    const [actionPart, sessionId] = interaction.customId.split(':');
    if (!actionPart || !sessionId) {
      await interaction.reply({ content: 'Invalid draw action.', ephemeral: true });
      return true;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: 'This draw session has expired. Run /draw again.',
        ephemeral: true
      });
      return true;
    }

    if (session.userId !== interaction.user.id) {
      await interaction.reply({
        content: 'Only the original requester can use these controls.',
        ephemeral: true
      });
      return true;
    }

    if (actionPart === 'draw_edit') {
      const modal = new ModalBuilder()
        .setCustomId(`draw_modal:${session.id}`)
        .setTitle('Edit Image');
      const promptInput = new TextInputBuilder()
        .setCustomId('draw_prompt')
        .setLabel('Updated prompt')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setValue(session.prompt.slice(0, 4000));
      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput);
      modal.addComponents(row);
      await interaction.showModal(modal);
      return true;
    }

    if (actionPart !== 'draw_regen') {
      await interaction.reply({ content: 'Unknown draw action.', ephemeral: true });
      return true;
    }

    await interaction.deferUpdate();

    try {
      if (this.quotaMiddleware && interaction.guildId) {
        const member = interaction.member as GuildMember;
        const quotaCheck = await this.quotaMiddleware.checkQuota(
          interaction.guildId,
          interaction.user.id,
          member,
          'images',
          session.quotaCost
        );

        if (!quotaCheck.allowed) {
          await interaction.followUp({
            content: `⚠️ ${quotaCheck.reason}`,
            ephemeral: true
          });
          return true;
        }
      }

      const generation = await this.generateImage({
        prompt: session.prompt,
        model: session.model,
        size: session.size,
        quality: session.quality,
        aspectRatio: session.aspectRatio,
        resolution: session.resolution,
        references: session.references
      });

      await interaction.message.edit({
        embeds: [generation.embed],
        files: generation.files,
        components: [this.createControls(session.id)]
      });

      session.createdAt = Date.now();
      this.sessions.set(session.id, session);

      if (this.quotaMiddleware && interaction.guildId) {
        await this.quotaMiddleware.recordUsage(
          interaction.guildId,
          interaction.user.id,
          'images',
          session.quotaCost
        );
      }
    } catch (error) {
      await interaction.followUp({
        content: `Regeneration failed: ${this.formatImageError(error, 'regeneration')}`,
        ephemeral: true
      });
    }

    return true;
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith('draw_modal:')) {
      return false;
    }

    this.cleanupSessions();

    const [, sessionId] = interaction.customId.split(':');
    if (!sessionId) {
      await interaction.reply({ content: 'Invalid draw edit request.', ephemeral: true });
      return true;
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        content: 'This draw session has expired. Run /draw again.',
        ephemeral: true
      });
      return true;
    }

    if (session.userId !== interaction.user.id) {
      await interaction.reply({
        content: 'Only the original requester can edit this image.',
        ephemeral: true
      });
      return true;
    }

    const updatedPrompt = interaction.fields.getTextInputValue('draw_prompt').trim();
    if (!updatedPrompt) {
      await interaction.reply({ content: 'Prompt cannot be empty.', ephemeral: true });
      return true;
    }

    if (this.quotaMiddleware && interaction.guildId) {
      const member = interaction.member as GuildMember;
      const quotaCheck = await this.quotaMiddleware.checkQuota(
        interaction.guildId,
        interaction.user.id,
        member,
        'images',
        session.quotaCost
      );

      if (!quotaCheck.allowed) {
        await interaction.reply({
          content: `⚠️ ${quotaCheck.reason}`,
          ephemeral: true
        });
        return true;
      }
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const generation = await this.generateImage({
        prompt: updatedPrompt,
        model: session.model,
        size: session.size,
        quality: session.quality,
        aspectRatio: session.aspectRatio,
        resolution: session.resolution,
        references: session.references
      });

      session.prompt = updatedPrompt;
      session.createdAt = Date.now();
      this.sessions.set(session.id, session);

      const channel = interaction.channel;
      if (channel && 'messages' in channel) {
        const originalMessage = await channel.messages.fetch(session.messageId);
        await originalMessage.edit({
          embeds: [generation.embed],
          files: generation.files,
          components: [this.createControls(session.id)]
        });
      }

      if (this.quotaMiddleware && interaction.guildId) {
        await this.quotaMiddleware.recordUsage(
          interaction.guildId,
          interaction.user.id,
          'images',
          session.quotaCost
        );
      }

      await interaction.editReply({ content: 'Image updated successfully.' });
    } catch (error) {
      await interaction.editReply({
        content: `Image edit failed: ${this.formatImageError(error, 'edit')}`
      });
    }

    return true;
  }
}
