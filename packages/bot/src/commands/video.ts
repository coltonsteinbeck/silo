import { ChatInputCommandInteraction, SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { Command } from './types';
import { logger } from '@silo/core';

interface VideoJob {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  progress?: number;
}

export class VideoCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('video')
    .setDescription('Generate a video with Sora')
    .addStringOption(option =>
      option
        .setName('prompt')
        .setDescription('Describe the video you want to create')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('model')
        .setDescription('Sora model to use')
        .setRequired(false)
        .addChoices(
          { name: 'Sora 2 (Fast)', value: 'sora-2' },
          { name: 'Sora 2 Pro (High Quality)', value: 'sora-2-pro' }
        )
    )
    .addStringOption(option =>
      option
        .setName('duration')
        .setDescription('Video duration in seconds')
        .setRequired(false)
        .addChoices(
          { name: '5 seconds', value: '5' },
          { name: '8 seconds', value: '8' },
          { name: '10 seconds', value: '10' }
        )
    )
    .addStringOption(option =>
      option
        .setName('size')
        .setDescription('Video resolution')
        .setRequired(false)
        .addChoices(
          { name: '720p (1280x720)', value: '1280x720' },
          { name: '1080p (1920x1080)', value: '1920x1080' }
        )
    );

  constructor(private apiKey: string | null) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.apiKey) {
      await interaction.reply({
        content: 'Video generation is not configured. OpenAI API key required.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    const prompt = interaction.options.getString('prompt', true);
    const model = interaction.options.getString('model') || 'sora-2';
    const seconds = interaction.options.getString('duration') || '8';
    const size = interaction.options.getString('size') || '1280x720';

    // Content safety check
    const safetyKeywords = [
      'nsfw',
      'nude',
      'explicit',
      'violence',
      'gore',
      'celebrity',
      'politician'
    ];
    if (safetyKeywords.some(keyword => prompt.toLowerCase().includes(keyword))) {
      await interaction.editReply(
        '⚠️ Your prompt contains content that may violate safety guidelines. Please try a different prompt.'
      );
      return;
    }

    try {
      await interaction.editReply('🎬 Starting video generation... This may take several minutes.');

      // Create video job using fetch
      const createResponse = await fetch('https://api.openai.com/v1/videos', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, prompt, seconds, size })
      });

      if (!createResponse.ok) {
        throw new Error(`API error: ${createResponse.statusText}`);
      }

      const video: VideoJob = (await createResponse.json()) as VideoJob;
      logger.info(`Video generation started: ${video.id}`);

      // Poll for completion
      let completedVideo = video;
      let attempts = 0;
      const maxAttempts = 120; // 20 minutes max

      while (
        (completedVideo.status === 'queued' || completedVideo.status === 'in_progress') &&
        attempts < maxAttempts
      ) {
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds

        const statusResponse = await fetch(`https://api.openai.com/v1/videos/${video.id}`, {
          headers: { Authorization: `Bearer ${this.apiKey}` }
        });

        if (!statusResponse.ok) {
          throw new Error('Failed to check video status');
        }

        completedVideo = (await statusResponse.json()) as VideoJob;

        const progress = completedVideo.progress || 0;
        if (attempts % 3 === 0) {
          // Update every 30 seconds
          await interaction.editReply(`🎬 Generating video... ${progress}% complete`);
        }

        attempts++;
      }

      if (completedVideo.status === 'failed') {
        await interaction.editReply(
          '❌ Video generation failed. Please try again with a different prompt.'
        );
        return;
      }

      if (completedVideo.status !== 'completed') {
        await interaction.editReply(
          '⏱️ Video generation is taking longer than expected. Please try again later.'
        );
        return;
      }

      // Download video
      await interaction.editReply('📥 Downloading video...');

      const downloadResponse = await fetch(
        `https://api.openai.com/v1/videos/${completedVideo.id}/content`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` }
        }
      );

      if (!downloadResponse.ok) {
        throw new Error('Failed to download video');
      }

      const arrayBuffer = await downloadResponse.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Check file size (Discord limit: 25MB for non-nitro)
      const sizeMB = buffer.length / (1024 * 1024);
      if (sizeMB > 25) {
        await interaction.editReply(
          `❌ Generated video is too large (${sizeMB.toFixed(1)}MB). Discord limit is 25MB. Try a shorter duration or lower resolution.`
        );
        return;
      }

      const attachment = new AttachmentBuilder(buffer, { name: 'generated-video.mp4' });

      await interaction.editReply({
        content: `✅ Video generated successfully!\n**Prompt:** ${prompt}`,
        files: [attachment]
      });

      logger.info(`Video generation completed: ${video.id}`);
    } catch (error) {
      logger.error('Video generation error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await interaction.editReply(`❌ Error generating video: ${errorMessage}`);
    }
  }
}
