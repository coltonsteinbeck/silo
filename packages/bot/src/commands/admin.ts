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
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('quota-override')
          .setDescription('Reset quota usage for one user or the whole server (ET day)')
          .addUserOption(option =>
            option
              .setName('user')
              .setDescription('User to reset (leave empty to reset all users)')
              .setRequired(false)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('safety-toggle')
          .setDescription('Toggle edgy input mode and deterministic sentiment review')
          .addBooleanOption(option =>
            option
              .setName('edgy-mode')
              .setDescription(
                'Allow mild user profanity while keeping strict harmful-content blocks'
              )
              .setRequired(true)
          )
          .addBooleanOption(option =>
            option
              .setName('deterministic-sentiment-review')
              .setDescription('Use deterministic sentiment review for edgy-mode moderation flow')
              .setRequired(false)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('safety-status')
          .setDescription('View current safety policy toggle status')
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
        case 'quota-override':
          await this.handleQuotaOverride(interaction);
          break;
        case 'safety-toggle':
          await this.handleSafetyToggle(interaction);
          break;
        case 'safety-status':
          await this.handleSafetyStatus(interaction);
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

    let tier: 'admin' | 'moderator' | 'trusted' | 'member' | 'restricted';
    let quotaLimits: {
      textTokens: number;
      images: number;
      voiceMinutes: number;
      visionTokens: number;
      videoTokens: number;
    };
    let usage: {
      textTokens: number;
      images: number;
      voiceMinutes: number;
      visionTokens: number;
      videoTokens: number;
    } | null;

    try {
      tier = await this.permissions.getUserRoleTier(guildId, targetUser.id, targetMember);
      quotaLimits = await this.adminDb.getRoleTierQuota(guildId, tier);
      usage = await this.adminDb.getUserDailyUsage(guildId, targetUser.id);
    } catch (error) {
      logger.error('Admin quota-view data fetch failed', {
        guildId,
        adminId: interaction.user.id,
        targetUserId: targetUser.id,
        error
      });
      await interaction.editReply({
        content: 'Unable to load quota status right now. Please try again in a moment.'
      });
      return;
    }

    const textUsed = usage?.textTokens || 0;
    const imagesUsed = usage?.images || 0;
    const voiceUsed = usage?.voiceMinutes || 0;
    const visionUsed = usage?.visionTokens || 0;
    const videoUsed = usage?.videoTokens || 0;

    const textPercent =
      quotaLimits.textTokens > 0 ? Math.round((textUsed / quotaLimits.textTokens) * 100) : 0;
    const imagesPercent =
      quotaLimits.images > 0 ? Math.round((imagesUsed / quotaLimits.images) * 100) : 0;
    const voicePercent =
      quotaLimits.voiceMinutes > 0 ? Math.round((voiceUsed / quotaLimits.voiceMinutes) * 100) : 0;
    const visionPercent =
      quotaLimits.visionTokens > 0 ? Math.round((visionUsed / quotaLimits.visionTokens) * 100) : 0;
    const videoPercent =
      quotaLimits.videoTokens > 0 ? Math.round((videoUsed / quotaLimits.videoTokens) * 100) : 0;

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
        },
        {
          name: '👁️ Vision Tokens',
          value: `${visionUsed.toLocaleString()} / ${quotaLimits.visionTokens.toLocaleString()}\n${this.progressBar(visionPercent)} ${visionPercent}%`,
          inline: true
        },
        {
          name: '🎬 Video Tokens',
          value: `${videoUsed.toLocaleString()} / ${quotaLimits.videoTokens.toLocaleString()}\n${this.progressBar(videoPercent)} ${videoPercent}%`,
          inline: true
        }
      )
      .setFooter({ text: 'Resets daily at midnight ET' })
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
            `🎤 Voice: ${stats.voiceMinutesUsed} minutes`,
            `👁️ Vision Tokens: ${stats.visionTokensUsed.toLocaleString()}`,
            `🎬 Video Tokens: ${stats.videoTokensUsed.toLocaleString()}`
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
      .setFooter({ text: 'Response-only token tracking • Resets at midnight ET' })
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
                `🎤 Voice: ${usage.voiceMinutes} min`,
                `👁️ Vision: ${usage.visionTokens.toLocaleString()} tokens`,
                `🎬 Video: ${usage.videoTokens.toLocaleString()} tokens`
              ].join('\n')
            : 'No usage today',
          inline: true
        }
      )
      .setFooter({ text: 'Quotas reset daily at midnight ET' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  private async handleQuotaOverride(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId!;
    const adminUserId = interaction.user.id;
    const targetUser = interaction.options.getUser('user');

    const cooldown = await this.adminDb.getQuotaOverrideCooldown(guildId, adminUserId);
    if (!cooldown.allowed) {
      const nextAvailableAt = cooldown.nextAvailableAt
        ? cooldown.nextAvailableAt.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour12: true,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: 'numeric',
            minute: '2-digit'
          })
        : 'in less than 24 hours';

      await interaction.editReply({
        content: `Cooldown active. You can use quota override again after ${nextAvailableAt} ET.`
      });
      return;
    }

    const result = await this.adminDb.applyQuotaOverride(guildId, adminUserId, targetUser?.id);

    await this.adminDb.logAction({
      guildId,
      userId: adminUserId,
      action: 'quota_override_applied',
      details: {
        scope: targetUser ? 'user' : 'all',
        targetUserId: targetUser?.id ?? null,
        affectedUsers: result.affectedUsers,
        usageDate: result.usageDate
      }
    });

    if (targetUser) {
      await interaction.editReply({
        content: `Quota override applied for <@${targetUser.id}>. Reset ET day usage (${result.usageDate}).`
      });
      return;
    }

    await interaction.editReply({
      content: `Quota override applied for all users in this server for ET day ${result.usageDate}. Affected users: ${result.affectedUsers}.`
    });
  }

  private async handleSafetyToggle(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId!;
    const edgyModeEnabled = interaction.options.getBoolean('edgy-mode') ?? false;
    const deterministicSentimentOption = interaction.options.getBoolean(
      'deterministic-sentiment-review'
    );

    const existingConfig = await this.adminDb.getServerConfig(guildId);
    const existingFeatures = existingConfig?.featuresEnabled || {};
    const deterministicSentimentReviewEnabled =
      deterministicSentimentOption ??
      existingFeatures.deterministicSentimentReviewEnabled ??
      edgyModeEnabled;

    const featuresEnabled = {
      ...existingFeatures,
      edgyModeEnabled,
      deterministicSentimentReviewEnabled
    };

    await this.adminDb.setServerConfig({
      guildId,
      featuresEnabled
    });

    await this.adminDb.logAction({
      guildId,
      userId: interaction.user.id,
      action: 'safety_policy_toggled',
      details: {
        edgyModeEnabled,
        deterministicSentimentReviewEnabled
      }
    });

    await interaction.editReply({
      content: [
        'Updated safety policy toggles:',
        `• Edgy input mode: ${edgyModeEnabled ? 'enabled' : 'disabled'}`,
        `• Deterministic sentiment review: ${deterministicSentimentReviewEnabled ? 'enabled' : 'disabled'}`
      ].join('\n')
    });
  }

  private async handleSafetyStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId!;
    const serverConfig = await this.adminDb.getServerConfig(guildId);
    const features = serverConfig?.featuresEnabled || {};

    await interaction.editReply({
      content: [
        'Current safety policy toggles:',
        `• Edgy input mode: ${features.edgyModeEnabled ? 'enabled' : 'disabled'}`,
        `• Deterministic sentiment review: ${features.deterministicSentimentReviewEnabled ? 'enabled' : 'disabled'}`
      ].join('\n')
    });
  }

  private progressBar(percent: number): string {
    const filled = Math.round(percent / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }
}
