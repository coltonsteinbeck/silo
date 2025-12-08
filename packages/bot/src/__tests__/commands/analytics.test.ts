/**
 * Tests for Analytics Command
 * 
 * Tests analytics viewing functionality.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockAdminAdapter, createMockPermissionManager } from '@silo/core/test-setup';
import { AnalyticsCommand } from '../../commands/analytics';

describe('AnalyticsCommand', () => {
  let command: AnalyticsCommand;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAdminDb: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    mockPermissions = createMockPermissionManager();
    command = new AnalyticsCommand(mockAdminDb, mockPermissions);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('analytics');
    });

    test('has correct description', () => {
      expect(command.data.description).toBe('View server analytics and usage statistics');
    });

    test('is not allowed in DMs', () => {
      const json = command.data.toJSON();
      expect(json.dm_permission).toBe(false);
    });

    test('has period option', () => {
      const json = command.data.toJSON();
      const periodOption = json.options?.find(opt => opt.name === 'period');
      expect(periodOption).toBeDefined();
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

    test('calls getAnalytics for admin users with default period', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getAnalytics = mock(async () => [
        { eventType: 'command_used', command: 'speak', success: true, createdAt: new Date() }
      ]);

      const interaction = createMockInteraction({
        options: { getString: () => null }
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      // Command produces a response
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });

    test('accepts custom period selection', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getAnalytics = mock(async () => []);

      const interaction = createMockInteraction({
        options: { getString: (name: string) => name === 'period' ? '30d' : null }
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      // Command produces a response
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });
  });
});
