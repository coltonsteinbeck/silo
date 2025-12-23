import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
  EmbedBuilder
} from 'discord.js';
import { Command } from './types';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { logger } from '@silo/core';

export class AnalyticsCommand implements Command {
  public readonly data;

  constructor(
    private adminDb: AdminAdapter,
    private permissions: PermissionManager
  ) {
    this.data = new SlashCommandBuilder()
      .setName('analytics')
      .setDescription('View server analytics and usage statistics')
      .setDMPermission(false)
      .addSubcommand(sub =>
        sub
          .setName('general')
          .setDescription('View general server analytics')
          .addStringOption(opt =>
            opt
              .setName('period')
              .setDescription('Time period for analytics')
              .addChoices(
                { name: 'Last 24 hours', value: '1d' },
                { name: 'Last 7 days', value: '7d' },
                { name: 'Last 30 days', value: '30d' }
              )
          )
      )
      .addSubcommand(sub =>
        sub.setName('quotas').setDescription('View server quota usage and limits')
      ) as SlashCommandBuilder;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.member) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const member = interaction.member;
    if (!(member instanceof GuildMember)) {
      await interaction.reply({
        content: 'Could not verify permissions.',
        ephemeral: true
      });
      return;
    }

    const canModerate = await this.permissions.canModerate(
      interaction.guildId,
      interaction.user.id,
      member
    );
    if (!canModerate) {
      await interaction.reply({
        content: 'You need moderator permissions to view analytics.',
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'quotas') {
      await this.handleQuotasAnalytics(interaction);
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });

      const period = interaction.options.getString('period') || '7d';
      const days = period === '1d' ? 1 : period === '7d' ? 7 : 30;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Get analytics data
      const [events, feedbackRaw, costAggregate] = await Promise.all([
        this.adminDb.getAnalytics(interaction.guildId, since),
        this.adminDb.getFeedbackStats(interaction.guildId, since),
        this.adminDb.getGuildCostAggregate(interaction.guildId)
      ]);

      // Command usage stats
      const commandStats = new Map<string, number>();
      const providerStats = new Map<string, number>();
      let totalCommands = 0;
      let successfulCommands = 0;
      let totalTokens = 0;
      let totalCost = 0;
      let totalResponseTime = 0;
      let responseTimeCount = 0;

      for (const event of events) {
        if (event.eventType === 'command_used' && event.command) {
          const count = commandStats.get(event.command) || 0;
          commandStats.set(event.command, count + 1);
          totalCommands++;

          if (event.success) successfulCommands++;
          if (event.tokensUsed) totalTokens += event.tokensUsed;
          if (event.estimatedCostUsd) totalCost += event.estimatedCostUsd;
          if (event.responseTimeMs) {
            totalResponseTime += event.responseTimeMs;
            responseTimeCount++;
          }
          if (event.provider) {
            const provCount = providerStats.get(event.provider) || 0;
            providerStats.set(event.provider, provCount + 1);
          }
        }
      }

      // Top commands
      const topCommands =
        Array.from(commandStats.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([cmd, count]) => `• **${cmd}**: ${count} uses`)
          .join('\n') || 'No commands used';

      // Provider distribution
      const providerDist =
        Array.from(providerStats.entries())
          .map(([provider, count]) => {
            const percent = ((count / totalCommands) * 100).toFixed(1);
            return `• **${provider}**: ${percent}%`;
          })
          .join('\n') || 'No AI usage';

      // Feedback stats
      const positive = feedbackRaw['positive'] || 0;
      const negative = feedbackRaw['negative'] || 0;
      const totalFeedback = positive + negative;
      const feedbackText =
        totalFeedback > 0
          ? `👍 ${positive} (${((positive / totalFeedback) * 100).toFixed(1)}%) • 👎 ${negative} (${((negative / totalFeedback) * 100).toFixed(1)}%)`
          : 'No feedback yet';

      // Average response time
      const avgResponseTime =
        responseTimeCount > 0 ? (totalResponseTime / responseTimeCount / 1000).toFixed(2) : 'N/A';

      // Success rate
      const successRate =
        totalCommands > 0 ? ((successfulCommands / totalCommands) * 100).toFixed(1) : '0';

      // Estimated cost (rough approximation)
      const aggCost = costAggregate?.totalCost ?? 0;
      const aggTokens = (costAggregate?.inputTokens ?? 0) + (costAggregate?.outputTokens ?? 0);

      const estimatedCost =
        aggCost > 0
          ? aggCost.toFixed(4)
          : totalCost > 0
            ? totalCost.toFixed(4)
            : ((totalTokens / 1000) * 0.002).toFixed(4); // fallback rough estimate

      const displayTokens = aggTokens > 0 ? aggTokens : totalTokens;

      const providerCostBreakdown = costAggregate?.providerBreakdown
        ? Object.entries(costAggregate.providerBreakdown)
            .filter(([, value]) => Number(value) > 0)
            .map(([provider, value]) => `• **${provider}**: $${Number(value).toFixed(4)}`)
            .join('\n') || 'No provider cost data'
        : 'No provider cost data';

      const embed = new EmbedBuilder()
        .setTitle(`📊 Analytics Dashboard (${days}d)`)
        .setColor(0x5865f2)
        .addFields(
          {
            name: '📈 Command Usage',
            value: `Total Commands: **${totalCommands}**\nSuccess Rate: **${successRate}%**\nAvg Response: **${avgResponseTime}s**`,
            inline: false
          },
          {
            name: '🏆 Top Commands',
            value: topCommands,
            inline: true
          },
          {
            name: '🤖 AI Provider Distribution',
            value: providerDist,
            inline: true
          },
          {
            name: '💬 User Feedback',
            value: feedbackText,
            inline: false
          },
          {
            name: '💰 Usage & Cost',
            value: `Total Tokens: **${displayTokens.toLocaleString()}**\nEst. Cost (30d window data): **$${estimatedCost}**`,
            inline: false
          },
          {
            name: '🧾 Provider Cost Breakdown (30d)',
            value: providerCostBreakdown,
            inline: false
          }
        )
        .setFooter({
          text: 'Analytics update in real-time • Costs are estimates'
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      // Log analytics access
      await this.adminDb.logAction({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        action: 'analytics_viewed',
        details: { period }
      });
    } catch (error) {
      logger.error('Error in analytics command:', error);
      const reply = {
        content: 'An error occurred while loading analytics.',
        ephemeral: true
      };
      if (interaction.deferred) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  }

  private async handleQuotasAnalytics(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ ephemeral: true });

      const guildId = interaction.guildId!;

      // Get current usage and limits
      const [usage, limits] = await Promise.all([
        this.adminDb.getGuildDailyUsage(guildId),
        this.adminDb.getGuildQuotaLimits(guildId)
      ]);

      const currentUsage = usage || {
        textTokens: 0,
        images: 0,
        voiceMinutes: 0,
        date: new Date()
      };

      // Calculate percentages and remaining
      const textPercent = ((currentUsage.textTokens / limits.textTokens) * 100).toFixed(1);
      const imagePercent = ((currentUsage.images / limits.images) * 100).toFixed(1);
      const voicePercent = ((currentUsage.voiceMinutes / limits.voiceMinutes) * 100).toFixed(1);

      const textRemaining = Math.max(0, limits.textTokens - currentUsage.textTokens);
      const imageRemaining = Math.max(0, limits.images - currentUsage.images);
      const voiceRemaining = Math.max(0, limits.voiceMinutes - currentUsage.voiceMinutes);

      // Determine color based on overall usage
      const avgPercent =
        (parseFloat(textPercent) + parseFloat(imagePercent) + parseFloat(voicePercent)) / 3;
      const embedColor = avgPercent >= 90 ? 0xff0000 : avgPercent >= 75 ? 0xffa500 : 0x00ff00;

      const embed = new EmbedBuilder()
        .setTitle('📊 Server Quota Usage')
        .setDescription('Daily quota usage and limits for this server')
        .setColor(embedColor)
        .addFields(
          {
            name: '📝 Text Generation',
            value: `**Used:** ${currentUsage.textTokens.toLocaleString()} / ${limits.textTokens.toLocaleString()} tokens\n**Remaining:** ${textRemaining.toLocaleString()} tokens (${textPercent}% used)`,
            inline: false
          },
          {
            name: '🎨 Image Generation',
            value: `**Used:** ${currentUsage.images} / ${limits.images} images\n**Remaining:** ${imageRemaining} images (${imagePercent}% used)`,
            inline: false
          },
          {
            name: '🎤 Voice Minutes',
            value: `**Used:** ${currentUsage.voiceMinutes} / ${limits.voiceMinutes} minutes\n**Remaining:** ${voiceRemaining} minutes (${voicePercent}% used)`,
            inline: false
          }
        )
        .setFooter({
          text: 'Quotas reset daily at midnight UTC • Contact admin to adjust limits'
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      // Log analytics access
      await this.adminDb.logAction({
        guildId,
        userId: interaction.user.id,
        action: 'quotas_viewed',
        details: { usage: currentUsage, limits }
      });
    } catch (error) {
      logger.error('Error in quotas analytics:', error);
      const reply = {
        content: 'An error occurred while loading quota information.',
        ephemeral: true
      };
      if (interaction.deferred) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  }
}
