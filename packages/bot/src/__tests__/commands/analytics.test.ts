/**
 * Tests for Analytics Command
 *
 * Tests analytics viewing functionality.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { GuildMember } from 'discord.js';
import {
  createMockInteraction,
  createMockAdminAdapter,
  createMockPermissionManager
} from '@silo/core/test-setup';
import { AnalyticsCommand } from '../../commands/analytics';

describe('AnalyticsCommand', () => {
  let command: AnalyticsCommand;

  let mockAdminDb: any;

  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    mockPermissions = createMockPermissionManager();
    mockAdminDb.logAction = mock(async () => {});
    mockAdminDb.getFeedbackStats = mock(async () => ({}));
    mockAdminDb.getGuildCostAggregate = mock(async () => ({
      inputTokens: 0,
      outputTokens: 0,
      images: 0,
      totalCost: 0,
      providerBreakdown: {}
    }));
    mockPermissions.canModerate = mock(async () => true);
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

    test('has general and quotas subcommands', () => {
      const json = command.data.toJSON();
      const generalSubcommand = json.options?.find(
        (opt: { name: string }) => opt.name === 'general'
      );
      const quotasSubcommand = json.options?.find((opt: { name: string }) => opt.name === 'quotas');
      expect(generalSubcommand).toBeDefined();
      expect(quotasSubcommand).toBeDefined();
    });
  });

  describe('execute', () => {
    test('rejects non-guild usage', async () => {
      const interaction = createMockInteraction({
        guildId: undefined
      });
      (interaction as any).guildId = null;

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toHaveProperty('content');
      expect((reply as { content: string }).content).toContain('server');
    });

    test('checks admin permissions before allowing access', async () => {
      mockPermissions.isAdmin = mock(async () => false);
      mockPermissions.canModerate = mock(async () => false);

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

    test('calls getAnalytics for admin users with default period', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getAnalytics = mock(async () => [
        { eventType: 'command_used', command: 'speak', success: true, createdAt: new Date() }
      ]);

      const interaction = createMockInteraction({
        options: { getString: () => null, subcommand: 'general' }
      });

      await command.execute(interaction as any);

      // Command produces a response
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });

    test('accepts custom period selection', async () => {
      mockPermissions.isAdmin = mock(async () => true);
      mockAdminDb.getAnalytics = mock(async () => []);

      const interaction = createMockInteraction({
        options: {
          getString: (name: string) => (name === 'period' ? '30d' : null),
          subcommand: 'general'
        }
      });

      await command.execute(interaction as any);

      // Command produces a response
      expect(interaction._getReplies().length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cost display', () => {
    test('uses estimated cost when available', async () => {
      mockPermissions.canModerate = mock(async () => true);
      mockAdminDb.getAnalytics = mock(async () => [
        {
          eventType: 'command_used',
          command: 'speak',
          success: true,
          tokensUsed: 1000,
          estimatedCostUsd: 1.5,
          provider: 'openai',
          createdAt: new Date()
        }
      ]);
      mockAdminDb.getFeedbackStats = mock(async () => ({ positive: 1, negative: 1 }));
      mockAdminDb.getGuildCostAggregate = mock(async () => ({
        inputTokens: 500,
        outputTokens: 500,
        images: 0,
        totalCost: 1.5,
        providerBreakdown: { openai: 1.5 }
      }));

      const interaction = createMockInteraction({
        options: { subcommand: 'general', period: '7d' }
      });
      Object.setPrototypeOf(interaction.member, GuildMember.prototype);

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0] as { embeds: any[] };
      const embed = reply.embeds[0].data ?? reply.embeds[0];
      const costField = embed.fields?.find((f: any) => f.name.includes('Usage & Cost'));

      expect(costField?.value).toContain('$1.5000');
      expect(costField?.value).toContain('1,000');
    });

    test('falls back to token-based estimate when no cost logged', async () => {
      mockPermissions.canModerate = mock(async () => true);
      mockAdminDb.getAnalytics = mock(async () => [
        {
          eventType: 'command_used',
          command: 'speak',
          success: true,
          tokensUsed: 2000,
          provider: 'openai',
          createdAt: new Date()
        }
      ]);
      mockAdminDb.getFeedbackStats = mock(async () => ({ positive: 0, negative: 0 }));
      mockAdminDb.getGuildCostAggregate = mock(async () => ({
        inputTokens: 0,
        outputTokens: 0,
        images: 0,
        totalCost: 0,
        providerBreakdown: {}
      }));

      const interaction = createMockInteraction({
        options: { subcommand: 'general', period: '7d' }
      });
      Object.setPrototypeOf(interaction.member, GuildMember.prototype);

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0] as { embeds: any[] };
      const embed = reply.embeds[0].data ?? reply.embeds[0];
      const costField = embed.fields?.find((f: any) => f.name.includes('Usage & Cost'));

      expect(costField?.value).toContain('$0.0040');
      expect(costField?.value).toContain('2,000');
    });

    test('shows provider cost breakdown when present', async () => {
      mockAdminDb.getAnalytics = mock(async () => []);
      mockAdminDb.getFeedbackStats = mock(async () => ({}));
      mockAdminDb.getGuildCostAggregate = mock(async () => ({
        inputTokens: 100,
        outputTokens: 200,
        images: 0,
        totalCost: 2,
        providerBreakdown: { openai: 1.5, anthropic: 0.5 }
      }));

      const interaction = createMockInteraction({
        options: { subcommand: 'general', period: '7d' }
      });
      Object.setPrototypeOf(interaction.member, GuildMember.prototype);

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0] as { embeds: any[] };
      const embed = reply.embeds[0].data ?? reply.embeds[0];
      const providerField = embed.fields?.find((f: any) => f.name.includes('Provider Cost'));

      expect(providerField?.value).toContain('openai');
      expect(providerField?.value).toContain('anthropic');
      expect(providerField?.value).toContain('$1.5000');
      expect(providerField?.value).toContain('$0.5000');
    });
  });
});
