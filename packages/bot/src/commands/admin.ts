import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  GuildMember
} from 'discord.js';
import { Command } from './types';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { logger } from '@silo/core';

export class AdminCommand implements Command {
  public readonly data: SlashCommandBuilder;

  constructor(
    private adminDb: AdminAdapter,
    private permissions: PermissionManager
  ) {
    this.data = new SlashCommandBuilder()
      .setName('admin')
      .setDescription('Admin control panel with bot statistics and server info')
      .setDMPermission(false);
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

    try {
      await interaction.deferReply({ ephemeral: true });

      // Get server configuration
      const config = await this.adminDb.getServerConfig(interaction.guildId);

      // Get recent analytics (last 24 hours)
      const analyticsStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const analytics = await this.adminDb.getAnalytics(interaction.guildId, analyticsStart);

      // Get recent audit logs (last 7 days)
      const auditLogs = await this.adminDb.getAuditLogs(interaction.guildId, 10);

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
        guildId: interaction.guildId,
        userId: interaction.user.id,
        action: 'admin_panel_viewed',
        details: {}
      });
    } catch (error) {
      logger.error('Error in admin command:', error);
      const reply = {
        content: 'An error occurred while loading the admin panel.',
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
