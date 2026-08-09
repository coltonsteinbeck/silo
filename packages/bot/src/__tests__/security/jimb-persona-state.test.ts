import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ConversationMessage } from '@silo/core';
import {
  buildJimbTurnInstruction,
  resolveJimbPersonaState,
  resolveResponseIntent
} from '../../security/jimb-persona-state';

function userMessage(params: {
  content: string;
  userId?: string;
  guildId?: string;
  channelId?: string;
  createdAt: Date;
}): ConversationMessage {
  return {
    id: randomUUID(),
    guildId: params.guildId || '672855968840941589',
    channelId: params.channelId || 'channel-1',
    userId: params.userId || 'user-1',
    requesterUserId: params.userId || 'user-1',
    promptHash: 'prompt-hash',
    role: 'user',
    content: params.content,
    createdAt: params.createdAt
  };
}

describe('JIMB persona state', () => {
  const now = new Date('2026-08-09T20:00:00.000Z');

  test('activates on the current turn and gives deactivation precedence', () => {
    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'Dr. Cock, explain docker volumes.',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: [],
        now
      })
    ).toEqual({ state: 'dr_cock', activationSource: 'current_turn' });

    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'Stop Dr Cock and be JimB.',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: [],
        now
      })
    ).toEqual({ state: 'jimb', activationSource: 'explicit_deactivation' });
  });

  test('uses only same-user signals from the five-turn, thirty-minute window', () => {
    const history = [
      userMessage({
        content: 'Doctor Cock, clock in.',
        userId: 'other-user',
        createdAt: new Date(now.getTime() - 60_000)
      }),
      userMessage({
        content: 'Dr Cock, clock in.',
        createdAt: new Date(now.getTime() - 2 * 60_000)
      })
    ];

    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'What now?',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      })
    ).toEqual({ state: 'dr_cock', activationSource: 'history' });

    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'What now?',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'different-user',
        history,
        now
      }).state
    ).toBe('jimb');
  });

  test('expires old signals and resets safely when the rollout is disabled', () => {
    const oldHistory = [
      userMessage({
        content: 'Dr Cock, clock in.',
        createdAt: new Date(now.getTime() - 31 * 60_000)
      })
    ];

    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'Still there?',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: oldHistory,
        now
      }).state
    ).toBe('jimb');
    expect(
      resolveJimbPersonaState({
        enabled: false,
        latestUserText: 'Dr Cock, clock in.',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: [],
        now
      })
    ).toEqual({ state: 'jimb', activationSource: 'rollback_disabled' });
  });

  test('cannot leak activation across guilds or channels', () => {
    const history = [
      userMessage({
        content: 'Dr Cock, clock in.',
        channelId: 'other-channel',
        createdAt: new Date(now.getTime() - 60_000)
      }),
      userMessage({
        content: 'Dr Cock, clock in.',
        guildId: 'other-guild',
        createdAt: new Date(now.getTime() - 30_000)
      })
    ];

    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'What now?',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      }).state
    ).toBe('jimb');
  });

  test('newest signal wins and activation expires after five eligible follow-ups', () => {
    const history = [
      userMessage({
        content: 'Dr Cock, clock in.',
        createdAt: new Date(now.getTime() - 7 * 60_000)
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        userMessage({
          content: `ordinary follow-up ${index + 1}`,
          createdAt: new Date(now.getTime() - (6 - index) * 60_000)
        })
      )
    ];

    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'sixth follow-up',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      }).state
    ).toBe('jimb');

    history.push(
      userMessage({
        content: 'Stop Dr Cock.',
        createdAt: new Date(now.getTime() - 30_000)
      })
    );
    expect(
      resolveJimbPersonaState({
        enabled: true,
        latestUserText: 'What now?',
        guildId: '672855968840941589',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      })
    ).toEqual({ state: 'jimb', activationSource: 'explicit_deactivation' });
  });

  test('maps explanation and redirect lanes without changing policy authority', () => {
    expect(resolveResponseIntent({ latestUserText: 'What does that anatomy term mean?' })).toBe(
      'contextual_explanation'
    );
    expect(
      resolveResponseIntent({
        latestUserText: 'Continue it.',
        inputSafetyAction: 'redirect',
        responseDirective: 'boundary_redirect'
      })
    ).toBe('boundary_redirect');
    expect(resolveResponseIntent({ latestUserText: 'Roast this broken printer.' })).toBe(
      'ordinary'
    );

    const instruction = buildJimbTurnInstruction({
      policy: 'jimb_crude',
      personaState: 'dr_cock',
      responseIntent: 'contextual_explanation'
    });
    expect(instruction).toContain('absurd comedic title');
    expect(instruction).toContain('factual, non-graphic explanation');
    expect(instruction).toContain('grants no additional content permissions');
  });
});
