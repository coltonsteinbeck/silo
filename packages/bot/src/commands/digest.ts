import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType
} from 'discord.js';
import { Command } from './types';
import { ProviderRegistry } from '../providers/registry';
import { AdminAdapter } from '../database/admin-adapter';

export class DigestCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('digest')
    .setDescription('Generate server activity digest')
    .addStringOption(option =>
      option
        .setName('period')
        .setDescription('Time period for digest')
        .setRequired(false)
        .addChoices(
          { name: '1 hour', value: '1h' },
          { name: '12 hours', value: '12h' },
          { name: 'Daily (24h)', value: 'daily' },
          { name: 'Weekly (7d)', value: 'weekly' }
        )
    )
    .addBooleanOption(option =>
      option
        .setName('include_stats')
        .setDescription('Include detailed statistics')
        .setRequired(false)
    );

  constructor(
    private registry: ProviderRegistry,
    private adminDb?: AdminAdapter
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();

    const period = interaction.options.getString('period') || 'daily';
    const includeStats = interaction.options.getBoolean('include_stats') ?? false;

    // Calculate time window
    const hours = this.getPeriodHours(period);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    if (!interaction.guild) {
      await interaction.editReply('This command can only be used in a server.');
      return;
    }

    // Collect messages from all text channels
    const channels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);

    let totalMessages = 0;
    const messagesByUser = new Map<string, number>();
    const messagesByChannel = new Map<string, number>();
    const allMessages: string[] = [];

    for (const [, channel] of channels) {
      if (!channel.isTextBased()) continue;

      try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const recentMessages = messages.filter(m => m.createdAt > since && !m.author.bot);

        for (const [, msg] of recentMessages) {
          totalMessages++;
          messagesByUser.set(msg.author.id, (messagesByUser.get(msg.author.id) || 0) + 1);
          messagesByChannel.set(channel.id, (messagesByChannel.get(channel.id) || 0) + 1);

          if (allMessages.length < 100) {
            allMessages.push(`${msg.author.username}: ${msg.content.slice(0, 200)}`);
          }
        }
      } catch {
        // Skip channels we can't access
        continue;
      }
    }

    if (totalMessages === 0) {
      await interaction.editReply(`No messages found in the last ${this.getPeriodLabel(period)}.`);
      return;
    }

    // Get guild's preferred provider
    let preferredProvider: string | undefined;
    if (this.adminDb && interaction.guildId) {
      const serverConfig = await this.adminDb.getServerConfig(interaction.guildId);
      preferredProvider = serverConfig?.defaultProvider || undefined;
    }

    // Generate AI summary
    const provider = this.registry.getTextProvider(preferredProvider);
    const context = allMessages.join('\n');

    const response = await provider.generateText(
      [
        {
          role: 'system',
          content: `You are summarizing Discord server activity. Provide a concise, engaging summary highlighting:
- Main topics discussed
- Notable moments or interesting exchanges
- Overall server mood/activity level
Keep it under 300 words and conversational.`
        },
        {
          role: 'user',
          content: `Summarize this server activity from the last ${this.getPeriodLabel(period)}:\n\n${context.slice(0, 4000)}`
        }
      ],
      { maxTokens: 500 }
    );

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle(`📊 Server Digest - ${this.getPeriodLabel(period)}`)
      .setDescription(response.content)
      .setColor(0x5865f2)
      .setTimestamp();

    if (includeStats) {
      const topUsers = Array.from(messagesByUser.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const topChannels = Array.from(messagesByChannel.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      embed.addFields(
        { name: '📈 Total Messages', value: totalMessages.toString(), inline: true },
        { name: '👥 Active Users', value: messagesByUser.size.toString(), inline: true },
        { name: '💬 Active Channels', value: messagesByChannel.size.toString(), inline: true }
      );

      if (topUsers.length > 0) {
        const userList = await Promise.all(
          topUsers.map(async ([userId, count]) => {
            try {
              const user = await interaction.client.users.fetch(userId);
              return `${user.username}: ${count}`;
            } catch {
              return `User ${userId}: ${count}`;
            }
          })
        );
        embed.addFields({
          name: '🏆 Most Active Users',
          value: userList.join('\n'),
          inline: false
        });
      }

      if (topChannels.length > 0) {
        const channelList = topChannels.map(([channelId, count]) => {
          const channel = interaction.guild!.channels.cache.get(channelId);
          return `${channel?.name || 'Unknown'}: ${count}`;
        });
        embed.addFields({
          name: '📌 Busiest Channels',
          value: channelList.join('\n'),
          inline: false
        });
      }
    }

    await interaction.editReply({ embeds: [embed] });
  }

  private getPeriodHours(period: string): number {
    switch (period) {
      case '1h':
        return 1;
      case '12h':
        return 12;
      case 'daily':
        return 24;
      case 'weekly':
        return 168;
      default:
        return 24;
    }
  }

  private getPeriodLabel(period: string): string {
    switch (period) {
      case '1h':
        return 'hour';
      case '12h':
        return '12 hours';
      case 'daily':
        return '24 hours';
      case 'weekly':
        return 'week';
      default:
        return '24 hours';
    }
  }
}
