import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} from 'discord.js';
import { Command } from './types';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { logger } from '@silo/core';

// Maximum system prompt length (characters)
const MAX_SYSTEM_PROMPT_LENGTH = 4000;
const PROMPT_MODAL_PREFILL_TIMEOUT_MS = 1200;

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
        sub
          .setName('alerts-channel')
          .setDescription('Set the channel for system alerts and notifications')
          .addChannelOption(opt =>
            opt
              .setName('channel')
              .setDescription('Channel for alerts (leave empty to use system channel)')
              .addChannelTypes(ChannelType.GuildText)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('system-prompt')
          .setDescription('Set a custom system prompt for AI responses')
          .addStringOption(opt =>
            opt
              .setName('action')
              .setDescription('What to do with the system prompt')
              .setRequired(true)
              .addChoices(
                { name: 'Set/Edit', value: 'edit' },
                { name: 'View', value: 'view' },
                { name: 'Enable', value: 'enable' },
                { name: 'Disable', value: 'disable' },
                { name: 'Clear', value: 'clear' }
              )
          )
          .addStringOption(opt =>
            opt
              .setName('type')
              .setDescription('Prompt type (default: text)')
              .addChoices(
                { name: 'Text Chat', value: 'text' },
                { name: 'Voice Chat', value: 'voice' }
              )
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

        case 'alerts-channel': {
          const channel = interaction.options.getChannel('channel');
          const channelId = channel?.id ?? interaction.guild?.systemChannelId ?? null;

          // Update the warning_channel_id in guild_registry
          await this.adminDb.setAlertsChannel(interaction.guildId, channelId);

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'config_changed',
            details: { setting: 'alerts-channel', value: channelId }
          });

          const channelMention = channelId ? `<#${channelId}>` : 'system channel';
          await interaction.reply({
            content: `✅ Alerts channel set to ${channelMention}`,
            ephemeral: true
          });
          break;
        }

        case 'system-prompt': {
          const action = interaction.options.getString('action', true);
          const promptType = interaction.options.getString('type') || 'text';
          const forVoice = promptType === 'voice';
          const typeLabel = forVoice ? 'voice' : 'text';

          switch (action) {
            case 'view': {
              const { prompt, enabled } = await this.adminDb.getSystemPrompt(
                interaction.guildId,
                forVoice
              );

              if (!prompt) {
                await interaction.reply({
                  content: `📝 No custom ${typeLabel} system prompt is set.\n\nUse \`/config system-prompt action:Set/Edit\` to add one.`,
                  ephemeral: true
                });
                return;
              }

              const status = enabled ? '✅ Enabled' : '⏸️ Disabled';
              const truncatedPrompt =
                prompt.length > 1500 ? prompt.substring(0, 1500) + '...\n*(truncated)*' : prompt;

              await interaction.reply({
                content: `**${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} System Prompt** (${status})\n\`\`\`\n${truncatedPrompt}\n\`\`\`\n*Length: ${prompt.length} characters*`,
                ephemeral: true
              });
              break;
            }

            case 'edit': {
              // Show modal quickly to avoid interaction timeout; prompt prefill is best-effort.
              const promptLookupPromise = this.adminDb
                .getSystemPrompt(interaction.guildId, forVoice)
                .then(result => result.prompt)
                .catch(error => {
                  logger.warn('Failed to preload system prompt for modal', {
                    guildId: interaction.guildId,
                    forVoice,
                    error
                  });
                  return null;
                });

              const prompt = await Promise.race<string | null>([
                promptLookupPromise,
                new Promise(resolve => {
                  setTimeout(() => resolve(null), PROMPT_MODAL_PREFILL_TIMEOUT_MS);
                })
              ]);

              const modal = new ModalBuilder()
                .setCustomId(`system_prompt_modal_${forVoice ? 'voice' : 'text'}`)
                .setTitle(
                  `Edit ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} System Prompt`
                );

              const promptInput = new TextInputBuilder()
                .setCustomId('prompt_input')
                .setLabel(`System Prompt (max ${MAX_SYSTEM_PROMPT_LENGTH} chars)`)
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('You are a helpful AI assistant...')
                .setMaxLength(MAX_SYSTEM_PROMPT_LENGTH)
                .setRequired(false);

              // Pre-fill with existing prompt if there is one
              if (prompt) {
                promptInput.setValue(prompt.slice(0, MAX_SYSTEM_PROMPT_LENGTH));
              }

              const row = new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput);
              modal.addComponents(row);

              await interaction.showModal(modal);
              break;
            }

            case 'enable': {
              await this.adminDb.toggleSystemPrompt(interaction.guildId, true, {
                actorUserId: interaction.user.id,
                promptType: forVoice ? 'voice' : 'text'
              });
              await interaction.reply({
                content: `✅ ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} system prompt **enabled**`,
                ephemeral: true
              });
              break;
            }

            case 'disable': {
              await this.adminDb.toggleSystemPrompt(interaction.guildId, false, {
                actorUserId: interaction.user.id,
                promptType: forVoice ? 'voice' : 'text'
              });
              await interaction.reply({
                content: `⏸️ ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} system prompt **disabled** (prompt preserved)`,
                ephemeral: true
              });
              break;
            }

            case 'clear': {
              await this.adminDb.setSystemPrompt(interaction.guildId, null, {
                forVoice,
                actorUserId: interaction.user.id
              });
              await interaction.reply({
                content: `🗑️ ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} system prompt **cleared**`,
                ephemeral: true
              });
              break;
            }
          }
          break;
        }

        case 'view': {
          const config = await this.adminDb.getServerConfig(interaction.guildId);
          const alertsChannelId = await this.adminDb.getAlertsChannel(interaction.guildId);
          const alertsChannel = alertsChannelId ? `<#${alertsChannelId}>` : 'Not set';
          const { prompt: textPrompt, enabled: textEnabled } = await this.adminDb.getSystemPrompt(
            interaction.guildId,
            false
          );
          const { prompt: voicePrompt } = await this.adminDb.getSystemPrompt(
            interaction.guildId,
            true
          );

          const textPromptStatus = textPrompt
            ? `${textEnabled ? '✅' : '⏸️'} Set (${textPrompt.length} chars)`
            : 'Not set';
          const voicePromptStatus = voicePrompt
            ? `Set (${voicePrompt.length} chars)`
            : 'Using text prompt';

          const lines = [
            '**Current Server Configuration:**',
            `• Default Provider: ${config?.defaultProvider || 'openai'}`,
            `• Auto Thread: ${config?.autoThread ? 'Enabled' : 'Disabled'}`,
            `• Memory Retention: ${config?.memoryRetentionDays || 30} days`,
            `• Rate Limit Multiplier: ${config?.rateLimitMultiplier || 1.0}x`,
            `• Alerts Channel: ${alertsChannel}`,
            `• Text System Prompt: ${textPromptStatus}`,
            `• Voice System Prompt: ${voicePromptStatus}`
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
