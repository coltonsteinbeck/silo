import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './types';
import { ProviderRegistry } from '../providers/registry';

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
          { name: '1024x1024', value: '1024x1024' },
          { name: '1792x1024', value: '1792x1024' },
          { name: '1024x1792', value: '1024x1792' }
        )
    )
    .addStringOption(option =>
      option
        .setName('style')
        .setDescription('Image style')
        .setRequired(false)
        .addChoices({ name: 'Vivid', value: 'vivid' }, { name: 'Natural', value: 'natural' })
    );

  constructor(private registry: ProviderRegistry) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const prompt = interaction.options.getString('prompt', true);
    const size = interaction.options.getString('size') || '1024x1024';
    const style = interaction.options.getString('style') || 'vivid';

    const provider = this.registry.getImageProvider();
    if (!provider) {
      await interaction.editReply(
        'No image generation provider configured. Check your .env settings.'
      );
      return;
    }

    try {
      const result = await provider.generateImage(prompt, {
        size,
        style
      });

      await interaction.editReply({
        content: result.revisedPrompt
          ? `Generated: ${result.revisedPrompt}`
          : 'Image generated successfully!',
        files: [result.url]
      });
    } catch (error) {
      await interaction.editReply(
        `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
