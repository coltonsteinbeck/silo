import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { ChannelType, GuildMember, MessageFlags } from 'discord.js';
import { AdminCommand } from '../../commands/admin';
import {
  createMockInteraction,
  createMockAdminAdapter,
  createMockPermissionManager
} from '@silo/core/test-setup';

const fixtureId = (suffix: string) => '1'.padEnd(16, '0') + suffix;
const guildId = fixtureId('01'),
  channelId = fixtureId('02');
const originalFetch = globalThis.fetch;
let db: any, permissions: any, interaction: any, channel: any;
const previousKey = process.env.PATCH_NOTES_ENCRYPTION_KEY;
const replyContent = () => {
  const reply = interaction._getReplies().at(-1);
  return typeof reply === 'string' ? reply : reply.content;
};
beforeEach(() => {
  db = createMockAdminAdapter();
  db.getPatchNotesWebhook = mock(async () => null);
  permissions = createMockPermissionManager();
  permissions.isAdmin = mock(async () => true);
  interaction = createMockInteraction({ guildId });
  Object.setPrototypeOf(interaction.member, GuildMember.prototype);
  interaction.options.getSubcommand = () => 'patch-notes-setup';
  interaction.options.getChannel = () => ({ id: channelId });
  channel = {
    id: channelId,
    guild: { id: guildId },
    type: ChannelType.GuildText,
    permissionsFor: mock(() => ({ has: () => true }))
  };
  interaction.guild = {
    channels: { fetch: mock(async () => channel) },
    members: {
      fetch: mock(async () => interaction.member),
      fetchMe: mock(async () => ({ id: fixtureId('05') }))
    }
  };
  globalThis.fetch = mock(async () => {
    throw new Error('No unexpected network calls');
  }) as unknown as typeof fetch;
  delete process.env.PATCH_NOTES_ENCRYPTION_KEY;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousKey === undefined) delete process.env.PATCH_NOTES_ENCRYPTION_KEY;
  else process.env.PATCH_NOTES_ENCRYPTION_KEY = previousKey;
});

test('registers setup/status/send with constrained channel and content options', () => {
  const data = new AdminCommand(db, permissions).data.toJSON();
  expect(data.options!.filter(option => option.name.startsWith('patch-notes-'))).toHaveLength(3);
  const setup: any = data.options!.find(option => option.name === 'patch-notes-setup');
  expect(setup.options[0].channel_types).toEqual([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement
  ]);
  const send: any = data.options!.find(option => option.name === 'patch-notes-send');
  expect(send.options.find((option: any) => option.name === 'notes').max_length).toBe(1800);
});

test('non-admin denial occurs before storage or channel access', async () => {
  permissions.isAdmin.mockImplementation(async () => false);
  await new AdminCommand(db, permissions).execute(interaction);
  expect(db.getPatchNotesWebhook).not.toHaveBeenCalled();
  expect(interaction.guild.channels.fetch).not.toHaveBeenCalled();
  expect(interaction._getReplies()[0]).toHaveProperty('flags', MessageFlags.Ephemeral);
});

test.each(['actor', 'bot'])(
  'missing %s channel permissions block setup before network',
  async identity => {
    channel.permissionsFor.mockImplementation((member: any) => ({
      has: () =>
        identity === 'actor' ? member !== interaction.member : member === interaction.member
    }));
    await new AdminCommand(db, permissions).execute(interaction);
    expect(replyContent()).toContain('Manage Webhooks');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }
);

test.each(['wrong-guild', 'forum'])(
  'unsupported channel %s cannot create a webhook',
  async failure => {
    if (failure === 'wrong-guild') channel.guild.id = fixtureId('99');
    else channel.type = ChannelType.GuildForum;
    await new AdminCommand(db, permissions).execute(interaction);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(replyContent()).toContain('Manage Webhooks');
  }
);

test('status returns a channel only and never leaks the stored credential', async () => {
  interaction.options.getSubcommand = () => 'patch-notes-status';
  db.getPatchNotesWebhook.mockImplementation(async () => ({
    channelId,
    encryptedToken: 'private-ciphertext',
    webhookId: 'private-id'
  }));
  await new AdminCommand(db, permissions).execute(interaction);
  expect(interaction._getReplies().at(-1).content).toContain(channelId);
  expect(JSON.stringify(interaction._getReplies())).not.toContain('private-ciphertext');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('missing encryption key fails privately before any external request', async () => {
  await new AdminCommand(db, permissions).execute(interaction);
  expect(replyContent()).toContain('PATCH_NOTES_ENCRYPTION_KEY');
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
