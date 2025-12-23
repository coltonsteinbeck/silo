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

export class DrawCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('draw')
    .setDescription('Generate an image with AI')
    .addStringOption(option =>
      option.setName('prompt').setDescription('Image description').setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('size')
        .setDescription('Image size')
        .setRequired(false)
        .addChoices(
          { name: '1024x1024 (Square)', value: '1024x1024' },
          { name: '1792x1024 (Landscape)', value: '1792x1024' },
          { name: '1024x1792 (Portrait)', value: '1024x1792' }
        )
    )
    .addStringOption(option =>
      option
        .setName('quality')
        .setDescription('Image quality')
        .setRequired(false)
        .addChoices(
          { name: 'Auto (Recommended)', value: 'auto' },
          { name: 'High', value: 'high' },
          { name: 'Medium', value: 'medium' },
          { name: 'Low', value: 'low' }
        )
    );

  constructor(
    private registry: ProviderRegistry,
    private quotaMiddleware?: QuotaMiddleware
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // Check quota before deferring (if quota middleware is available)
    if (this.quotaMiddleware && interaction.guildId) {
      const member = interaction.member as GuildMember;
      const quotaCheck = await this.quotaMiddleware.checkQuota(
        interaction.guildId,
        interaction.user.id,
        member,
        'images',
        1
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

    const prompt = interaction.options.getString('prompt', true);
    const size = interaction.options.getString('size') || '1024x1024';
    const quality = interaction.options.getString('quality') || 'auto';

    const provider = this.registry.getImageProvider();
    if (!provider) {
      await interaction.editReply(
        'No image generation provider configured. Check your .env settings.'
      );
      return;
    }

    try {
      console.log('[DrawCommand] Generating image:', {
        prompt: prompt.substring(0, 100),
        size,
        quality,
        userId: interaction.user.id,
        guildId: interaction.guildId
      });

      const result = await provider.generateImage(prompt, {
        size,
        quality
      });

      console.log('[DrawCommand] Image generated successfully:', {
        hasUrl: !!result.url,
        urlLength: result.url?.length,
        hasRevisedPrompt: !!result.revisedPrompt
      });

      // Handle data URI (base64) from gpt-image-1
      let fileAttachment;
      const fileName = 'image.png';
      if (result.url.startsWith('data:image/')) {
        const base64Data = result.url.split(',')[1];
        if (!base64Data) {
          throw new Error('Invalid base64 image data');
        }
        const buffer = Buffer.from(base64Data, 'base64');
        fileAttachment = new AttachmentBuilder(buffer, { name: fileName });
      } else {
        // Regular URL from dall-e models
        fileAttachment = result.url;
      }

      const embed = new EmbedBuilder()
        .setTitle('🎨 Image Generated')
        .setDescription(`**Prompt:** ${result.revisedPrompt || prompt}`)
        .setImage(`attachment://${fileName}`)
        .setFooter({
          text: `Generated with GPT Image 1 • ${new Date().toLocaleDateString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: '2-digit'
          })}, ${new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          })}`
        });

      await interaction.editReply({
        embeds: [embed],
        files: [fileAttachment]
      });

      // Record usage after successful generation
      if (this.quotaMiddleware && interaction.guildId) {
        await this.quotaMiddleware.recordUsage(
          interaction.guildId,
          interaction.user.id,
          'images',
          1
        );
      }
    } catch (error) {
      console.error('[DrawCommand] Error generating image:', error);
      await interaction.editReply(
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
