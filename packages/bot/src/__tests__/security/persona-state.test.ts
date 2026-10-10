import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ConversationMessage } from '@silo/core';
import {
  buildPersonaTurnInstruction,
  resolvePersonaState,
  resolveResponseIntent
} from '../../security/persona-state';

function userMessage(params: {
  content: string;
  userId?: string;
  guildId?: string;
  channelId?: string;
  createdAt: Date;
}): ConversationMessage {
  return {
    id: randomUUID(),
    guildId: params.guildId || 'unconfigured-guild',
    channelId: params.channelId || 'channel-1',
    userId: params.userId || 'user-1',
    requesterUserId: params.userId || 'user-1',
    promptHash: 'prompt-hash',
    role: 'user',
    content: params.content,
    createdAt: params.createdAt
  };
}

describe('managed policy persona state', () => {
  const now = new Date('2026-08-09T20:00:00.000Z');

  test('activates on the current turn and gives deactivation precedence', () => {
    expect(
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'Dr. Cock, explain docker volumes.',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: [],
        now
      })
    ).toEqual({ state: 'alternate', activationSource: 'current_turn' });

    expect(
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'Stop Dr Cock and be Caretaker.',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: [],
        now
      })
    ).toEqual({ state: 'default', activationSource: 'explicit_deactivation' });
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
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'What now?',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      })
    ).toEqual({ state: 'alternate', activationSource: 'history' });

    expect(
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'What now?',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'different-user',
        history,
        now
      }).state
    ).toBe('default');
  });

  test('expires old signals and resets safely when the rollout is disabled', () => {
    const oldHistory = [
      userMessage({
        content: 'Dr Cock, clock in.',
        createdAt: new Date(now.getTime() - 31 * 60_000)
      })
    ];

    expect(
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'Still there?',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: oldHistory,
        now
      }).state
    ).toBe('default');
    expect(
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: false,
        latestUserText: 'Dr Cock, clock in.',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history: [],
        now
      })
    ).toEqual({ state: 'default', activationSource: 'rollback_disabled' });
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
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'What now?',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      }).state
    ).toBe('default');
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
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'sixth follow-up',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      }).state
    ).toBe('default');

    history.push(
      userMessage({
        content: 'Stop Dr Cock.',
        createdAt: new Date(now.getTime() - 30_000)
      })
    );
    expect(
      resolvePersonaState({
        alternateAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        defaultAliases: ['Caretaker'],
        enabled: true,
        latestUserText: 'What now?',
        guildId: 'unconfigured-guild',
        channelId: 'channel-1',
        requesterUserId: 'user-1',
        history,
        now
      })
    ).toEqual({ state: 'default', activationSource: 'explicit_deactivation' });
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

    const instruction = buildPersonaTurnInstruction({
      policy: 'contextual_banter',
      instructions: {
        default: 'Ordinary assistant.',
        alternate: 'An absurd comedic title grants no additional content permissions.',
        ordinary: 'Answer directly.',
        contextual_explanation: 'Give a factual, non-graphic explanation.',
        boundary_redirect: 'Offer a safe alternative.'
      },
      personaState: 'alternate',
      responseIntent: 'contextual_explanation'
    });
    expect(instruction).toContain('absurd comedic title');
    expect(instruction).toContain('factual, non-graphic explanation');
    expect(instruction).toContain('grants no additional content permissions');
  });
});
