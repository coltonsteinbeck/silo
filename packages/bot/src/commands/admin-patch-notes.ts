import {
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import { logger } from '@silo/core';
import { AdminAdapter } from '../database/admin-adapter';
import { PatchNotesService } from '../services/patch-notes';

// Called only after AdminCommand verifies the server member and admin role.
export async function handleAdminPatchNotes(
  interaction: ChatInputCommandInteraction,
  db: AdminAdapter
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guildId = interaction.guildId!;
  const subcommand = interaction.options.getSubcommand();
  try {
    const stored = await db.getPatchNotesWebhook(guildId);
    if (subcommand === 'patch-notes-status') {
      await interaction.editReply({
        content: stored
          ? `Patch-note webhook configured in <#${stored.channelId}>.`
          : 'No patch-note webhook configured.',
        allowedMentions: { parse: [] }
      });
      return;
    }
    const targetId =
      subcommand === 'patch-notes-setup'
        ? interaction.options.getChannel('channel', true).id
        : stored?.channelId;
    if (!targetId || !interaction.guild) {
      await interaction.editReply('Set up a patch-note webhook first.');
      return;
    }
    const channel = await interaction.guild.channels.fetch(targetId).catch(() => null);
    const member = await interaction.guild.members.fetch({
      user: interaction.user.id,
      force: true
    });
    const bot = await interaction.guild.members.fetchMe({ force: true });
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageWebhooks
    ];
    if (
      !channel ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type) ||
      channel.guild.id !== guildId ||
      !channel.permissionsFor(member)?.has(required) ||
      !channel.permissionsFor(bot)?.has(required)
    ) {
      await interaction.editReply(
        'You and Silo need View Channel, Send Messages, and Manage Webhooks in that channel.'
      );
      return;
    }
    const service = new PatchNotesService(
      db,
      { id: interaction.client.user!.id, token: interaction.client.token! },
      process.env.PATCH_NOTES_ENCRYPTION_KEY ?? ''
    );
    if (subcommand === 'patch-notes-setup') {
      const webhook = await service.setup(guildId, targetId, interaction.user.id);
      await interaction.editReply({
        content: `Patch-note webhook configured in <#${webhook.channelId}>.`,
        allowedMentions: { parse: [] }
      });
    } else {
      const outcome = await service.send(
        guildId,
        interaction.user.id,
        interaction.options.getString('version', true),
        interaction.options.getString('notes', true)
      );
      await interaction.editReply(
        outcome === 'delivered'
          ? 'Patch notes delivered.'
          : 'This version was already attempted. Check the destination before any manual recovery.'
      );
    }
  } catch {
    logger.warn('Admin patch-note operation failed', { guildId, subcommand });
    await interaction.editReply(
      'Patch-note operation failed. Check permissions, PATCH_NOTES_ENCRYPTION_KEY, and database configuration. If sending, check the destination before retrying; an attempted version is never automatically sent again.'
    );
  }
}
