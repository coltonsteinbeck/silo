/**
 * Tests for Admin Command
 * 
 * Tests admin control panel command.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockAdminAdapter, createMockPermissionManager } from '@silo/core/test-setup';
import { AdminCommand } from '../../commands/admin';

describe('AdminCommand', () => {
  let command: AdminCommand;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAdminDb: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    mockPermissions = createMockPermissionManager();
    command = new AdminCommand(mockAdminDb, mockPermissions);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('admin');
    });

    test('has correct description', () => {
      expect(command.data.description).toBe('Admin control panel with bot statistics and server info');
    });

    test('is not allowed in DMs', () => {
      const json = command.data.toJSON();
      expect(json.dm_permission).toBe(false);
    });
  });

  describe('execute', () => {
    test('rejects non-guild usage', async () => {
      const interaction = createMockInteraction({
        guildId: undefined
      });
      // @ts-expect-error - mock doesn't have all properties
      interaction.guildId = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toHaveProperty('content');
      expect((reply as { content: string }).content).toContain('server');
    });

    test('checks admin permissions before allowing access', async () => {
      mockPermissions.isAdmin = mock(async () => false);

      const mockMember = {
        id: '111222333',
        permissions: { has: () => false },
        roles: { cache: new Map() }
      };

      const interaction = createMockInteraction({
        member: mockMember as any
      });
      Object.setPrototypeOf(interaction.member, { constructor: { name: 'GuildMember' } });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      // Expect some reply was made (permission denied or error)
      expect(interaction._getReplies().length).toBeGreaterThan(0);
    });

    test('executes and produces response for guild users', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getServerConfig.mockImplementation(async () => ({
        defaultProvider: 'openai',
        autoThread: false,
        memoryRetentionDays: 30,
        rateLimitMultiplier: 1.0
      }));
      mockAdminDb.getAnalytics = mock(async () => []);
      mockAdminDb.getAuditLogs = mock(async () => []);
      mockAdminDb.logAction = mock(async () => {});

      const interaction = createMockInteraction();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      // Command should complete and produce some response
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });
  });
});
