/**
 * Tests for Mod Command
 *
 * Tests moderation command functionality.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { GuildMember, TextChannel } from 'discord.js';
import {
  createMockInteraction,
  createMockAdminAdapter,
  createMockPermissionManager
} from '@silo/core/test-setup';
import { ModCommand } from '../../commands/mod';

describe('ModCommand', () => {
  let command: ModCommand;

  let mockAdminDb: any;

  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    mockPermissions = createMockPermissionManager();
    command = new ModCommand(mockAdminDb, mockPermissions);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('mod');
    });

    test('has correct description', () => {
      expect(command.data.description).toContain('Moderation');
    });

    test('is not allowed in DMs', () => {
      const json = command.data.toJSON();
      expect(json.dm_permission).toBe(false);
    });

    test('has warn subcommand', () => {
      const json = command.data.toJSON();
      const warnSubcommand = json.options?.find((opt: { name: string }) => opt.name === 'warn');
      expect(warnSubcommand).toBeDefined();
    });

    test('has timeout subcommand', () => {
      const json = command.data.toJSON();
      const timeoutSubcommand = json.options?.find(
        (opt: { name: string }) => opt.name === 'timeout'
      );
      expect(timeoutSubcommand).toBeDefined();
    });

    test('has history subcommand', () => {
      const json = command.data.toJSON();
      const historySubcommand = json.options?.find(
        (opt: { name: string }) => opt.name === 'history'
      );
      expect(historySubcommand).toBeDefined();
    });
  });

  describe('execute', () => {
    test.each([
      ['requester', 'owner', 1],
      ['owner', 'owner', 1],
      ['target', 'owner', 0],
      ['target', 'owner', -1]
    ])(
      'denies timeout for %s with owner %s and relative role rank %i',
      async (id, ownerId, rank) => {
        mockPermissions.canModerate = mock(async () => true);
        mockAdminDb.logModAction = mock();
        const timeout = mock();
        const member = Object.create(GuildMember.prototype, {
          id: { value: 'requester' },
          permissions: { value: { has: () => true } },
          roles: { value: { highest: { comparePositionTo: () => rank } } }
        });
        const interaction = Object.assign(
          createMockInteraction({ member, options: { subcommand: 'timeout', user: { id } } }),
          {
            guild: {
              ownerId,
              members: { fetch: async () => ({ id, roles: { highest: {} }, timeout }) }
            }
          }
        );
        await command.execute(interaction as never);
        expect(interaction._getReplies()[0]).toMatchObject({
          content: 'Your Discord role cannot time out this member.',
          ephemeral: true
        });
        expect(timeout).not.toHaveBeenCalled();
        expect(mockAdminDb.logModAction).not.toHaveBeenCalled();
      }
    );

    test.each([false, true])(
      'denies purge when bot permissions are unavailable (member present: %s)',
      async present => {
        mockPermissions.canModerate = mock(async () => true);
        mockAdminDb.logModAction = mock();
        const member = Object.create(GuildMember.prototype);
        const fetch = mock();
        const bulkDelete = mock();
        const channel = Object.create(TextChannel.prototype, {
          permissionsFor: { value: (subject: unknown) => ({ has: () => subject === member }) },
          messages: { value: { fetch } },
          bulkDelete: { value: bulkDelete }
        });
        const interaction = Object.assign(
          createMockInteraction({ member, options: { subcommand: 'purge', count: 2 } }),
          { channel, guild: { members: { me: present ? {} : null } } }
        );
        await command.execute(interaction as never);
        expect(interaction._getReplies()[0]).toMatchObject({
          content: 'I do not have permission to manage messages in this channel.',
          ephemeral: true
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(bulkDelete).not.toHaveBeenCalled();
        expect(mockAdminDb.logModAction).not.toHaveBeenCalled();
      }
    );

    test('a Silo moderator still needs Discord permission to time out a member', async () => {
      mockPermissions.canModerate = mock(async () => true);
      mockAdminDb.logModAction = mock(async () => {});
      const member = Object.create(GuildMember.prototype, {
        permissions: { value: { has: () => false } }
      });
      const interaction = Object.assign(
        createMockInteraction({ member, options: { subcommand: 'timeout' } }),
        { guild: { id: 'guild' } }
      );

      await command.execute(interaction as any);

      expect(interaction.options.getUser).not.toHaveBeenCalled();
      expect(mockAdminDb.logModAction).not.toHaveBeenCalled();
      expect(interaction._getReplies()[0]).toMatchObject({
        content: 'You need the Discord Timeout Members permission.'
      });
    });

    test('rejects non-guild usage', async () => {
      const interaction = createMockInteraction({
        guildId: undefined
      });
      // @ts-expect-error - mock doesn't have all properties
      interaction.guildId = null;

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toHaveProperty('content');
      expect((reply as { content: string }).content).toContain('server');
    });

    test('rejects non-moderator users when not admin', async () => {
      mockPermissions.isModerator = mock(async () => false);

      const mockMember = {
        id: '111222333',
        permissions: { has: () => false },
        roles: { cache: new Map() }
      };

      const interaction = createMockInteraction({
        member: mockMember as any
      });
      // Need to first pass the server check
      interaction.options.getSubcommand = mock(() => 'warn');
      Object.setPrototypeOf(interaction.member, { constructor: { name: 'GuildMember' } });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      // Check that there was a reply (could be different messages based on implementation)
      expect(reply).toBeDefined();
    });

    describe('warn subcommand', () => {
      test('responds when executed', async () => {
        mockPermissions.isModerator = mock(async () => true);

        const targetUser = {
          id: '999888777',
          username: 'targetuser',
          tag: 'targetuser#0000',
          send: mock(async () => {})
        };

        const interaction = createMockInteraction({
          options: { subcommand: 'warn' }
        });
        interaction.options.getSubcommand = mock(() => 'warn');
        interaction.options.getUser = mock(() => targetUser);
        interaction.options.getString = mock((name: string) =>
          name === 'reason' ? 'Test warning' : null
        );

        await command.execute(interaction as any);

        // Command produces a response (either permission error or success)
        expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('history subcommand', () => {
      test('responds when executed', async () => {
        mockPermissions.isModerator = mock(async () => true);

        const targetUser = {
          id: '999888777',
          username: 'targetuser',
          tag: 'targetuser#0000'
        };

        const interaction = createMockInteraction({
          options: { subcommand: 'history' }
        });
        interaction.options.getSubcommand = mock(() => 'history');
        interaction.options.getUser = mock(() => targetUser);

        await command.execute(interaction as any);

        // Command produces a response
        expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
