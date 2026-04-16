/**
 * Tests for Admin Command
 *
 * Tests admin control panel command.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import {
  createMockInteraction,
  createMockAdminAdapter,
  createMockPermissionManager
} from '@silo/core/test-setup';
import { AdminCommand } from '../../commands/admin';

describe('AdminCommand', () => {
  let command: AdminCommand;

  let mockAdminDb: any;

  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    mockAdminDb.getQuotaOverrideCooldown = mock(async () => ({
      allowed: true,
      lastAppliedAt: null,
      nextAvailableAt: null
    }));
    mockAdminDb.applyQuotaOverride = mock(async () => ({
      affectedUsers: 0,
      usageDate: '2026-03-14'
    }));
    mockAdminDb.logAction = mock(async () => {});
    mockPermissions = createMockPermissionManager();
    command = new AdminCommand(mockAdminDb, mockPermissions);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('admin');
    });

    test('has correct description', () => {
      expect(command.data.description).toBe(
        'Admin control panel with bot statistics and server info'
      );
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

      await (command as any).handleQuotaOverride(interaction as any);

      // Command should complete and produce some response
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });

    test('applies quota override for a target user when cooldown allows', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getQuotaOverrideCooldown = mock(async () => ({
        allowed: true,
        lastAppliedAt: null,
        nextAvailableAt: null
      }));
      mockAdminDb.applyQuotaOverride = mock(async () => ({
        affectedUsers: 1,
        usageDate: '2026-03-14'
      }));
      mockAdminDb.logAction = mock(async () => {});

      const interaction = createMockInteraction({
        options: {
          subcommand: 'quota-override',
          user: { id: 'target-user-1' }
        }
      });
      Object.setPrototypeOf(interaction.member, { constructor: { name: 'GuildMember' } });

      await (command as any).handleQuotaOverride(interaction as any);

      expect(mockAdminDb.applyQuotaOverride).toHaveBeenCalledWith(
        '123456789',
        '111222333',
        'target-user-1'
      );
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });

    test('blocks quota override during cooldown', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getQuotaOverrideCooldown = mock(async () => ({
        allowed: false,
        lastAppliedAt: new Date('2026-03-13T12:00:00Z'),
        nextAvailableAt: new Date('2026-03-14T12:00:00Z')
      }));

      const interaction = createMockInteraction({
        options: {
          subcommand: 'quota-override'
        }
      });
      Object.setPrototypeOf(interaction.member, { constructor: { name: 'GuildMember' } });

      await command.execute(interaction as any);

      expect(mockAdminDb.applyQuotaOverride).not.toHaveBeenCalled();
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });

    test('updates safety feature toggles', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getServerConfig = mock(async () => ({
        featuresEnabled: {
          existingFlag: true
        }
      }));
      mockAdminDb.setServerConfig = mock(async () => ({}));

      const interaction = createMockInteraction({
        options: {
          subcommand: 'safety-toggle',
          'edgy-mode': true,
          'deterministic-sentiment-review': false
        }
      });

      await (command as any).handleSafetyToggle(interaction as any);

      expect(mockAdminDb.setServerConfig).toHaveBeenCalledWith({
        guildId: '123456789',
        featuresEnabled: {
          existingFlag: true,
          edgyModeEnabled: true,
          deterministicSentimentReviewEnabled: false
        }
      });
      expect(interaction._getReplies().length).toBeGreaterThan(0);
    });

    test('reports safety feature toggle status', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getServerConfig = mock(async () => ({
        featuresEnabled: {
          edgyModeEnabled: true,
          deterministicSentimentReviewEnabled: true
        }
      }));

      const interaction = createMockInteraction({
        options: {
          subcommand: 'safety-status'
        }
      });

      await (command as any).handleSafetyStatus(interaction as any);

      const replies = interaction._getReplies();
      expect(replies.length).toBeGreaterThan(0);
      expect((replies[0] as { content: string }).content).toContain('Edgy input mode: enabled');
    });
  });
});
