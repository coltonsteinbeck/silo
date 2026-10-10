import { describe, expect, mock, test } from 'bun:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { AnalyticsEvent } from '@silo/core';
type LoggedEvent = Omit<AnalyticsEvent, 'id' | 'createdAt'>;
import { executeCommandWithAnalytics } from '../../runtime/command-execution';

const interaction = (guildId: string | null = 'guild-a', userId = 'user-a') =>
  ({ guildId, user: { id: userId }, commandName: 'help' }) as ChatInputCommandInteraction;

describe('command execution analytics', () => {
  test('records one completed command without inventing provider usage', async () => {
    const execute = mock(async () => {});
    const logEvent = mock(async (_event: LoggedEvent) => {});
    await executeCommandWithAnalytics({ execute }, interaction(), { logEvent });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]).toEqual([
      {
        guildId: 'guild-a',
        userId: 'user-a',
        eventType: 'command_used',
        command: 'help',
        success: true,
        responseTimeMs: expect.any(Number),
        metadata: { outcomeScope: 'handler_completion' }
      }
    ]);
  });

  test('records a failed handler and preserves the original error', async () => {
    const failure = new Error('handler failed');
    const execute = mock(async () => {
      throw failure;
    });
    const logEvent = mock(async (_event: LoggedEvent) => {});
    await expect(
      executeCommandWithAnalytics({ execute }, interaction(), { logEvent })
    ).rejects.toBe(failure);
    expect(logEvent.mock.calls[0]?.[0]).toMatchObject({ success: false });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('analytics failure neither retries the command nor hides its error', async () => {
    const failure = new Error('command failed');
    const execute = mock(async () => {
      throw failure;
    });
    const logEvent = mock(async () => {
      throw new Error('storage failed');
    });
    await expect(
      executeCommandWithAnalytics({ execute }, interaction(), { logEvent })
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1);
    await executeCommandWithAnalytics({ execute: async () => {} }, interaction(), { logEvent });
  });

  test('does not write a guild event for a direct message', async () => {
    const logEvent = mock(async (_event: LoggedEvent) => {});
    await executeCommandWithAnalytics({ execute: async () => {} }, interaction(null), { logEvent });
    expect(logEvent).not.toHaveBeenCalled();
  });

  test('interleaved commands retain their own guild and user identities', async () => {
    const events: Array<{ guildId: string; userId: string }> = [];
    let finishFirst!: () => void;
    const first = new Promise<void>(resolve => {
      finishFirst = resolve;
    });
    const analytics = {
      logEvent: async (event: { guildId: string; userId: string }) => {
        events.push(event);
      }
    };
    const pending = executeCommandWithAnalytics({ execute: () => first }, interaction(), analytics);
    await executeCommandWithAnalytics(
      { execute: async () => {} },
      interaction('guild-b', 'user-b'),
      analytics
    );
    finishFirst();
    await pending;
    expect(events.map(({ guildId, userId }) => [guildId, userId])).toEqual([
      ['guild-b', 'user-b'],
      ['guild-a', 'user-a']
    ]);
  });
});
