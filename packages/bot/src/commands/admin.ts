import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  GuildMember,
  SlashCommandSubcommandsOnlyBuilder
} from 'discord.js';
import { Command } from './types';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { logger } from '@silo/core';

export class AdminCommand implements Command {
  public readonly data: SlashCommandSubcommandsOnlyBuilder;

  constructor(
    private adminDb: AdminAdapter,
    private permissions: PermissionManager
  ) {
    this.data = new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Admin control panel with bot statistics and server info')
      .setDMPermission(false)
      .addSubcommand(subcommand =>
        subcommand.setName('panel').setDescription('View the admin control panel')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('quota-view')
          .setDescription("View a user's quota status")
          .addUserOption(option =>
            option
              .setName('user')
              .setDescription('User to view quota for (defaults to yourself)')
              .setRequired(false)
          )
      )
      .addSubcommand(subcommand =>
        subcommand.setName('quota-stats').setDescription("View guild's quota usage statistics")
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('quota-history')
          .setDescription("View user's quota exhaustion and reset history")
          .addUserOption(option =>
            option.setName('user').setDescription('User to view history for').setRequired(false)
          )
      );
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
      await interaction.reply({ content: 'Could not verify permissions.', ephemeral: true });
      return;
    }

    const isAdmin = await this.permissions.isAdmin(
      interaction.guildId,
      interaction.user.id,
      member
    );
    if (!isAdmin) {
      await interaction.reply({
        content: 'You need admin permissions to use this command.',
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'panel':
          await this.handlePanel(interaction, member);
          break;
        case 'quota-view':
          await this.handleQuotaView(interaction, member);
          break;
        case 'quota-stats':
          await this.handleQuotaStats(interaction);
          break;
        case 'quota-history':
          await this.handleQuotaHistory(interaction);
          break;
        default:
          await interaction.reply({
            content: 'Unknown subcommand.',
            ephemeral: true
          });
      }
    } catch (error) {
      logger.error('Error in admin command:', error);
      const reply = {
        content: 'An error occurred while executing the command.',
        ephemeral: true
      };
      if (interaction.deferred) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  }

  private async handlePanel(
    interaction: ChatInputCommandInteraction,
    _member: GuildMember
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    // Get server configuration
    const config = await this.adminDb.getServerConfig(interaction.guildId!);

    // Get recent analytics (last 24 hours)
    const analyticsStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const analytics = await this.adminDb.getAnalytics(interaction.guildId!, analyticsStart);

    // Get recent audit logs (last 7 days)
    const auditLogs = await this.adminDb.getAuditLogs(interaction.guildId!, 10);

    // Calculate command usage stats
    const commandStats = new Map<string, number>();
    let totalCommands = 0;
    for (const event of analytics) {
      if (event.eventType === 'command_used' && event.command) {
        const count = commandStats.get(event.command) || 0;
        commandStats.set(event.command, count + 1);
        totalCommands++;
      }
    }

    const topCommands =
      Array.from(commandStats.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cmd, count]) => `• ${cmd}: ${count} uses`)
        .join('\n') || 'No commands used';

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Admin Control Panel')
      .setColor(0x5865f2)
      .addFields(
        {
          name: '📊 Server Statistics (24h)',
          value: `Total Commands: ${totalCommands}\nTop Commands:\n${topCommands}`,
          inline: false
        },
        {
          name: '⚙️ Server Configuration',
          value: [
            `Default Provider: ${config?.defaultProvider || 'openai'}`,
            `Auto Thread: ${config?.autoThread ? '✅' : '❌'}`,
            `Memory Retention: ${config?.memoryRetentionDays || 30} days`,
            `Rate Limit Multiplier: ${config?.rateLimitMultiplier || 1.0}x`
          ].join('\n'),
          inline: false
        },
        {
          name: '📝 Recent Activity',
          value: `${auditLogs.length} actions in last 7 days`,
          inline: false
        }
      )
      .setFooter({
        text: 'Use /config to modify settings • /analytics for detailed metrics • /mod for moderation'
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    // Log admin panel access
    await this.adminDb.logAction({
      guildId: interaction.guildId!,
      userId: interaction.user.id,
      action: 'admin_panel_viewed',
      details: {}
    });
  }

  private async handleQuotaView(
    interaction: ChatInputCommandInteraction,
    member: GuildMember
  ): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const guildId = interaction.guildId!;

    // Get the target member to determine their tier
    let targetMember: GuildMember;
    try {
      targetMember =
        targetUser.id === interaction.user.id
          ? member
          : await interaction.guild!.members.fetch(targetUser.id);
    } catch {
      await interaction.editReply({
        content: 'Could not find that user in this server.'
      });
      return;
    }

    // Get user's role tier and quota limits
    const tier = await this.permissions.getUserRoleTier(guildId, targetUser.id, targetMember);
    const quotaLimits = await this.adminDb.getRoleTierQuota(guildId, tier);
    const usage = await this.adminDb.getUserDailyUsage(guildId, targetUser.id);

    const textUsed = usage?.textTokens || 0;
    const imagesUsed = usage?.images || 0;
    const voiceUsed = usage?.voiceMinutes || 0;

    const textPercent =
      quotaLimits.textTokens > 0 ? Math.round((textUsed / quotaLimits.textTokens) * 100) : 0;
    const imagesPercent =
      quotaLimits.images > 0 ? Math.round((imagesUsed / quotaLimits.images) * 100) : 0;
    const voicePercent =
      quotaLimits.voiceMinutes > 0 ? Math.round((voiceUsed / quotaLimits.voiceMinutes) * 100) : 0;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Quota Status: ${targetUser.username}`)
      .setColor(0x5865f2)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: 'Role Tier', value: tier.charAt(0).toUpperCase() + tier.slice(1), inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        { name: '\u200B', value: '\u200B', inline: true },
        {
          name: '💬 Text Tokens',
          value: `${textUsed.toLocaleString()} / ${quotaLimits.textTokens.toLocaleString()}\n${this.progressBar(textPercent)} ${textPercent}%`,
          inline: true
        },
        {
          name: '🎨 Images',
          value: `${imagesUsed} / ${quotaLimits.images}\n${this.progressBar(imagesPercent)} ${imagesPercent}%`,
          inline: true
        },
        {
          name: '🎤 Voice Minutes',
          value: `${voiceUsed} / ${quotaLimits.voiceMinutes}\n${this.progressBar(voicePercent)} ${voicePercent}%`,
          inline: true
        }
      )
      .setFooter({ text: 'Resets daily at midnight UTC' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

    logger.debug('Admin quota view', {
      adminId: interaction.user.id,
      targetUser: targetUser.id,
      guildId
    });
  }

  private async handleQuotaStats(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId!;

    // Get guild quota stats
    const stats = await this.adminDb.getGuildQuotaStats(guildId);
    const accuracy = await this.adminDb.getQuotaAccuracyStats(7);

    const embed = new EmbedBuilder()
      .setTitle('📈 Guild Quota Statistics')
      .setColor(0x5865f2)
      .addFields(
        {
          name: "📊 Today's Usage",
          value: [
            `💬 Text Tokens: ${stats.textTokensUsed.toLocaleString()}`,
            `🎨 Images: ${stats.imagesUsed}`,
            `🎤 Voice: ${stats.voiceMinutesUsed} minutes`
          ].join('\n'),
          inline: true
        },
        {
          name: '👥 Active Users',
          value: `${stats.uniqueUsers} unique users today`,
          inline: true
        },
        {
          name: '🔔 Pending Notifications',
          value: `${stats.pendingResetNotifications} users awaiting reset`,
          inline: true
        },
        {
          name: '🎯 Estimate Accuracy (7-day)',
          value: accuracy.avgRatio
            ? [
                `Avg Ratio: ${accuracy.avgRatio.toFixed(3)}`,
                `Samples: ${accuracy.sampleCount.toLocaleString()}`,
                accuracy.stdDev ? `Std Dev: ${accuracy.stdDev.toFixed(3)}` : ''
              ]
                .filter(Boolean)
                .join('\n')
            : 'No data yet (need 10+ samples)',
          inline: false
        }
      )
      .setFooter({ text: 'Response-only token tracking • Resets at midnight UTC' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  private async handleQuotaHistory(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const guildId = interaction.guildId!;

    // Get user's usage history (last 7 days from analytics)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const analytics = await this.adminDb.getAnalytics(guildId, weekAgo);

    // Filter to this user's events
    const userEvents = analytics.filter(e => e.userId === targetUser.id);

    // Count events by type
    const textRequests = userEvents.filter(
      e => e.eventType === 'command_used' && e.command !== 'draw' && e.command !== 'speak'
    ).length;
    const imageRequests = userEvents.filter(e => e.command === 'draw').length;
    const voiceRequests = userEvents.filter(e => e.command === 'speak').length;

    // Get current quota status
    const usage = await this.adminDb.getUserDailyUsage(guildId, targetUser.id);

    const embed = new EmbedBuilder()
      .setTitle(`📜 Quota History: ${targetUser.username}`)
      .setColor(0x5865f2)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        {
          name: '📊 Last 7 Days',
          value: [
            `💬 Text Requests: ${textRequests}`,
            `🎨 Image Requests: ${imageRequests}`,
            `🎤 Voice Sessions: ${voiceRequests}`
          ].join('\n'),
          inline: true
        },
        {
          name: "📅 Today's Usage",
          value: usage
            ? [
                `💬 Tokens: ${usage.textTokens.toLocaleString()}`,
                `🎨 Images: ${usage.images}`,
                `🎤 Voice: ${usage.voiceMinutes} min`
              ].join('\n')
            : 'No usage today',
          inline: true
        }
      )
      .setFooter({ text: 'Quotas reset daily at midnight UTC' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  private progressBar(percent: number): string {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }
}
