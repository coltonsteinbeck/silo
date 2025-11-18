import { ChatInputCommandInteraction, SlashCommandBuilder, GuildMember } from 'discord.js';
import { Command } from './types';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { logger } from '@silo/core';

export class ConfigCommand implements Command {
  public readonly data;

  constructor(
    private adminDb: AdminAdapter,
    private permissions: PermissionManager
  ) {
    this.data = new SlashCommandBuilder()
      .setName('config')
      .setDescription('Configure server settings')
      .setDMPermission(false)
      .addSubcommand(sub =>
        sub
          .setName('provider')
          .setDescription('Set the default AI provider for this server')
          .addStringOption(opt =>
            opt
              .setName('provider')
              .setDescription('AI provider to use')
              .setRequired(true)
              .addChoices(
                { name: 'OpenAI', value: 'openai' },
                { name: 'Anthropic', value: 'anthropic' },
                { name: 'xAI', value: 'xai' },
                { name: 'Google', value: 'google' }
              )
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('auto-thread')
          .setDescription('Enable or disable automatic thread creation')
          .addBooleanOption(opt =>
            opt.setName('enabled').setDescription('Enable automatic threads').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('retention')
          .setDescription('Set memory retention period in days')
          .addIntegerOption(opt =>
            opt
              .setName('days')
              .setDescription('Number of days to retain memories (1-365)')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(365)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('rate-limit')
          .setDescription('Set rate limit multiplier')
          .addNumberOption(opt =>
            opt
              .setName('multiplier')
              .setDescription('Multiplier for rate limits (0.1-10.0)')
              .setRequired(true)
              .setMinValue(0.1)
              .setMaxValue(10.0)
          )
      )
      .addSubcommand(sub =>
        sub.setName('view').setDescription('View current server configuration')
      ) as any;
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
        case 'provider': {
          const provider = interaction.options.getString('provider', true);
          await this.adminDb.setServerConfig({
            guildId: interaction.guildId,
            defaultProvider: provider as any
          });

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'config_changed',
            details: { setting: 'provider', value: provider }
          });

          await interaction.reply({
            content: `✅ Default AI provider set to **${provider}**`,
            ephemeral: true
          });
          break;
        }

        case 'auto-thread': {
          const enabled = interaction.options.getBoolean('enabled', true);
          await this.adminDb.setServerConfig({
            guildId: interaction.guildId,
            autoThread: enabled
          });

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'config_changed',
            details: { setting: 'auto-thread', value: enabled }
          });

          await interaction.reply({
            content: `✅ Automatic threads ${enabled ? 'enabled' : 'disabled'}`,
            ephemeral: true
          });
          break;
        }

        case 'retention': {
          const days = interaction.options.getInteger('days', true);
          await this.adminDb.setServerConfig({
            guildId: interaction.guildId,
            memoryRetentionDays: days
          });

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'config_changed',
            details: { setting: 'retention', value: days }
          });

          await interaction.reply({
            content: `✅ Memory retention set to **${days}** days`,
            ephemeral: true
          });
          break;
        }

        case 'rate-limit': {
          const multiplier = interaction.options.getNumber('multiplier', true);
          await this.adminDb.setServerConfig({
            guildId: interaction.guildId,
            rateLimitMultiplier: multiplier
          });

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'config_changed',
            details: { setting: 'rate-limit', value: multiplier }
          });

          await interaction.reply({
            content: `✅ Rate limit multiplier set to **${multiplier}x**`,
            ephemeral: true
          });
          break;
        }

        case 'view': {
          const config = await this.adminDb.getServerConfig(interaction.guildId);
          const lines = [
            '**Current Server Configuration:**',
            `• Default Provider: ${config?.defaultProvider || 'openai'}`,
            `• Auto Thread: ${config?.autoThread ? 'Enabled' : 'Disabled'}`,
            `• Memory Retention: ${config?.memoryRetentionDays || 30} days`,
            `• Rate Limit Multiplier: ${config?.rateLimitMultiplier || 1.0}x`
          ];

          await interaction.reply({
            content: lines.join('\n'),
            ephemeral: true
          });
          break;
        }

        default:
          await interaction.reply({
            content: 'Unknown subcommand.',
            ephemeral: true
          });
      }
    } catch (error) {
      logger.error('Error in config command:', error);
      await interaction.reply({
        content: 'An error occurred while updating configuration.',
        ephemeral: true
      });
    }
  }
}
