import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ChannelType,
  ThreadAutoArchiveDuration
} from 'discord.js';
import { Command } from './types';
import { DatabaseAdapter } from '@silo/core';
import { ProviderRegistry } from '../providers/registry';

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
    private registry: ProviderRegistry
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.editReply('This command can only be used in text channels.');
      return;
    }

    let threadName = interaction.options.getString('name');

    // AI-generate thread name if not provided
    if (!threadName) {
      const history = await this.db.getConversationHistory(interaction.channelId, 5);
      if (history.length > 0) {
        const provider = this.registry.getTextProvider();
        const context = history.map(m => m.content).join('\n');

        const response = await provider.generateText(
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

        threadName = response.content.trim().slice(0, 100);
      } else {
        threadName = `Chat with ${interaction.user.username}`;
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
