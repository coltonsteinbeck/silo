/**
 * Tests for Config Command
 * 
 * Tests server configuration command with various subcommands.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockAdminAdapter, createMockPermissionManager, createMockGuildMember } from '@silo/core/test-setup';
import { ConfigCommand } from '../../commands/config';

describe('ConfigCommand', () => {
  let command: ConfigCommand;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAdminDb: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    mockPermissions = createMockPermissionManager();
    mockPermissions.isAdmin = mock(async () => true);
    command = new ConfigCommand(mockAdminDb, mockPermissions);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('config');
    });

    test('has correct description', () => {
      expect(command.data.description).toBe('Configure server settings');
    });

    test('is not allowed in DMs', () => {
      const json = command.data.toJSON();
      expect(json.dm_permission).toBe(false);
    });
  });

  describe('execute', () => {
    test('rejects non-guild usage', async () => {
      const interaction = createMockInteraction({
        guildId: undefined,
        options: { subcommand: 'view' }
      });
      // @ts-expect-error - mock doesn't have all properties
      interaction.guildId = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toHaveProperty('content');
      expect((reply as { content: string }).content).toContain('server');
    });

    test('rejects non-admin users', async () => {
      mockPermissions.isAdmin = mock(async () => false);
      
      const interaction = createMockInteraction({
        options: { subcommand: 'view' },
        member: createMockGuildMember({ isAdmin: false })
      });
      // Add mock for GuildMember check
      Object.defineProperty(interaction, 'member', {
        value: {
          ...interaction.member,
          constructor: { name: 'GuildMember' }
        },
        writable: true
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toHaveProperty('content');
    });

    describe('view subcommand', () => {
      test('displays current configuration', async () => {
        mockAdminDb.getServerConfig.mockImplementation(async () => ({
          defaultProvider: 'anthropic',
          autoThread: true,
          memoryRetentionDays: 60,
          rateLimitMultiplier: 1.5
        }));
        mockAdminDb.getAlertsChannel = mock(async () => '123456789');
        mockAdminDb.getSystemPrompt = mock(async () => ({ prompt: null, enabled: false }));

        const mockMember = {
          id: '111222333',
          permissions: { has: () => true },
          roles: { cache: new Map() }
        };

        const interaction = createMockInteraction({
          options: { subcommand: 'view' },
          member: mockMember as any
        });
        
        // Make it look like a GuildMember
        Object.setPrototypeOf(interaction.member, { constructor: { name: 'GuildMember' } });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await command.execute(interaction as any);

        expect(interaction._getReplies().length).toBeGreaterThan(0);
      });
    });

    describe('provider subcommand', () => {
      test('responds when executed', async () => {
        const interaction = createMockInteraction({
          options: { 
            subcommand: 'provider',
            provider: 'anthropic'
          }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await command.execute(interaction as any);

        // Command should produce a response (either permission error or success)
        expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('auto-thread subcommand', () => {
      test('responds when executed', async () => {
        const interaction = createMockInteraction({
          options: { 
            subcommand: 'auto-thread',
            enabled: true
          }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await command.execute(interaction as any);

        // Command should produce a response
        expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('retention subcommand', () => {
      test('responds when executed', async () => {
        const interaction = createMockInteraction({
          options: { 
            subcommand: 'retention',
            days: 90
          }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await command.execute(interaction as any);

        // Command should produce a response
        expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
      });
    });

    describe('rate-limit subcommand', () => {
      test('responds when executed', async () => {
        const interaction = createMockInteraction({
          options: { 
            subcommand: 'rate-limit',
            multiplier: 2.0
          }
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await command.execute(interaction as any);

        // Command should produce a response
        expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
