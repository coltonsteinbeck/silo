import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  GuildMember,
  PermissionFlagsBits,
  TextChannel
} from 'discord.js';
import { Command } from './types';
import { AdminAdapter } from '../database/admin-adapter';
import { PermissionManager } from '../permissions/manager';
import { logger } from '@silo/core';

export class ModCommand implements Command {
  public readonly data;

  constructor(
    private adminDb: AdminAdapter,
    private permissions: PermissionManager
  ) {
    this.data = new SlashCommandBuilder()
      .setName('mod')
      .setDescription('Moderation commands')
      .setDMPermission(false)
      .addSubcommand(sub =>
        sub
          .setName('warn')
          .setDescription('Warn a user')
          .addUserOption(opt =>
            opt.setName('user').setDescription('User to warn').setRequired(true)
          )
          .addStringOption(opt =>
            opt.setName('reason').setDescription('Reason for the warning').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('timeout')
          .setDescription('Timeout a user')
          .addUserOption(opt =>
            opt.setName('user').setDescription('User to timeout').setRequired(true)
          )
          .addIntegerOption(
            opt =>
              opt
                .setName('duration')
                .setDescription('Duration in minutes')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(40320) // 28 days max
          )
          .addStringOption(opt =>
            opt.setName('reason').setDescription('Reason for the timeout').setRequired(true)
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('purge')
          .setDescription('Delete messages')
          .addIntegerOption(opt =>
            opt
              .setName('count')
              .setDescription('Number of messages to delete (1-100)')
              .setRequired(true)
              .setMinValue(1)
              .setMaxValue(100)
          )
          .addUserOption(opt =>
            opt.setName('user').setDescription('Only delete messages from this user')
          )
      )
      .addSubcommand(sub =>
        sub
          .setName('history')
          .setDescription('View moderation history')
          .addUserOption(opt =>
            opt.setName('user').setDescription('User to view history for').setRequired(false)
          )
      ) as any;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.member || !interaction.guild) {
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
        content: 'You need moderator permissions to use this command.',
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'warn': {
          const targetUser = interaction.options.getUser('user', true);
          const reason = interaction.options.getString('reason', true);

          await this.adminDb.logModAction({
            guildId: interaction.guildId,
            moderatorId: interaction.user.id,
            targetUserId: targetUser.id,
            actionType: 'warn',
            reason
          });

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'user_warned',
            targetId: targetUser.id,
            details: { reason }
          });

          await interaction.reply({
            content: `✅ Warned ${targetUser.tag} for: ${reason}`,
            ephemeral: true
          });

          // Try to DM the user
          try {
            await targetUser.send(
              `You have been warned in **${interaction.guild.name}**\nReason: ${reason}`
            );
          } catch {
            // User has DMs disabled, that's okay
          }
          break;
        }

        case 'timeout': {
          const targetUser = interaction.options.getUser('user', true);
          const duration = interaction.options.getInteger('duration', true);
          const reason = interaction.options.getString('reason', true);

          const targetMember = await interaction.guild.members.fetch(targetUser.id);
          if (!targetMember) {
            await interaction.reply({
              content: 'Could not find that user in this server.',
              ephemeral: true
            });
            return;
          }

          // Check if bot has permission
          if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
            await interaction.reply({
              content: 'I do not have permission to timeout members.',
              ephemeral: true
            });
            return;
          }

          // Timeout the member
          await targetMember.timeout(duration * 60 * 1000, reason);

          await this.adminDb.logModAction({
            guildId: interaction.guildId,
            moderatorId: interaction.user.id,
            targetUserId: targetUser.id,
            actionType: 'timeout',
            reason,
            duration
          });

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'user_timed_out',
            targetId: targetUser.id,
            details: { reason, duration }
          });

          await interaction.reply({
            content: `✅ Timed out ${targetUser.tag} for ${duration} minutes\nReason: ${reason}`,
            ephemeral: true
          });

          // Try to DM the user
          try {
            await targetUser.send(
              `You have been timed out in **${interaction.guild.name}** for ${duration} minutes\nReason: ${reason}`
            );
          } catch {
            // User has DMs disabled
          }
          break;
        }

        case 'purge': {
          const count = interaction.options.getInteger('count', true);
          const targetUser = interaction.options.getUser('user');

          if (!(interaction.channel instanceof TextChannel)) {
            await interaction.reply({
              content: 'This command can only be used in text channels.',
              ephemeral: true
            });
            return;
          }

          // Check if bot has permission
          if (
            !interaction.channel
              .permissionsFor(interaction.guild.members.me!)
              ?.has(PermissionFlagsBits.ManageMessages)
          ) {
            await interaction.reply({
              content: 'I do not have permission to manage messages in this channel.',
              ephemeral: true
            });
            return;
          }

          await interaction.deferReply({ ephemeral: true });

          // Fetch messages
          const messages = await interaction.channel.messages.fetch({ limit: count });
          const messagesToDelete = targetUser
            ? messages.filter(msg => msg.author.id === targetUser.id)
            : messages;

          // Delete messages
          const deleted = await interaction.channel.bulkDelete(messagesToDelete, true);

          await this.adminDb.logModAction({
            guildId: interaction.guildId,
            moderatorId: interaction.user.id,
            targetUserId: targetUser?.id,
            actionType: 'purge',
            reason: `Deleted ${deleted.size} messages`,
            messageCount: deleted.size
          });

          await this.adminDb.logAction({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: 'messages_purged',
            targetId: interaction.channel.id,
            details: { count: deleted.size, targetUser: targetUser?.id }
          });

          await interaction.editReply({
            content: `✅ Deleted ${deleted.size} message(s)${targetUser ? ` from ${targetUser.tag}` : ''}`
          });
          break;
        }

        case 'history': {
          const targetUser = interaction.options.getUser('user');
          const history = await this.adminDb.getModHistory(
            interaction.guildId,
            targetUser?.id || undefined,
            20
          );

          if (history.length === 0) {
            await interaction.reply({
              content: targetUser
                ? `No moderation history for ${targetUser.tag}`
                : 'No moderation history in this server',
              ephemeral: true
            });
            return;
          }

          const lines = history.slice(0, 10).map(action => {
            const date = action.createdAt.toLocaleDateString();
            const user = `<@${action.targetUserId}>`;
            return `• **${action.actionType}** ${user} - ${action.reason} (${date})`;
          });

          await interaction.reply({
            content: `**Moderation History** (showing ${lines.length}/${history.length}):\n${lines.join('\n')}`,
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
      logger.error('Error in mod command:', error);
      const reply = {
        content: 'An error occurred while executing the moderation action.',
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
