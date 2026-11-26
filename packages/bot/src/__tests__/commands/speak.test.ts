/**
 * Tests for Speak Command
 *
 * Tests voice channel join functionality.
 */

import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import { createMockInteraction, createMockAdminAdapter } from '@silo/core/test-setup';
import { SpeakCommand } from '../../commands/speak';
import { StopSpeakingCommand } from '../../commands/stopspeaking';
import { VoiceSessionManager, voiceSessionManager } from '../../voice';
import type { VoiceQuotaJournal } from '../../voice/quota-journal';
import type { QuotaMiddleware } from '../../middleware/quota';

function createVoiceInteraction() {
  const voice = {
    id: 'fixture-voice',
    name: 'Voice',
    type: ChannelType.GuildVoice,
    guild: { id: 'fixture-guild', voiceAdapterCreator: {} },
    permissionsFor: () => ({ has: () => true })
  };
  const member = {
    id: 'fixture-member',
    permissions: { has: () => true },
    roles: { cache: new Map() },
    voice: { channel: voice, channelId: voice.id }
  };
  return {
    ...createMockInteraction({ guildId: voice.guild.id, userId: member.id, member }),
    id: 'fixture-interaction'
  };
}

describe('SpeakCommand', () => {
  let command: SpeakCommand;

  let mockAdminDb: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    command = new SpeakCommand(mockAdminDb);
  });

  describe('data', () => {
    test('has correct command name "speak"', () => {
      expect(command.data.name).toBe('speak');
    });

    test('has description mentioning voice functionality', () => {
      expect(command.data.description).toContain('voice');
    });

    test('includes voice selection option', () => {
      const json = command.data.toJSON();
      const voiceOption = json.options?.find(opt => opt.name === 'voice');
      expect(voiceOption).toBeDefined();
    });

    test('exports valid slash command JSON', () => {
      const json = command.data.toJSON();
      expect(json.name).toBe('speak');
      expect(json.description).toBeDefined();
    });
  });

  describe('execute', () => {
    test('rejects an unavailable journal before reserving quota or joining', async () => {
      const reserveQuota = mock(async () => {});
      const quota = { reserveQuota } as unknown as QuotaMiddleware;
      const journal = {
        assertReady: () => {
          throw new Error('journal unavailable');
        }
      } as unknown as VoiceQuotaJournal;
      const join = spyOn(voiceSessionManager, 'joinChannel');
      try {
        const interaction = createVoiceInteraction();
        await new SpeakCommand(mockAdminDb, quota, journal).execute(interaction as never);
        expect(interaction._getReplies()).toEqual([
          { content: 'Voice quota is unavailable.', ephemeral: true }
        ]);
        expect(reserveQuota).not.toHaveBeenCalled();
        expect(join).not.toHaveBeenCalled();
      } finally {
        join.mockRestore();
      }
    });

    test('/speak reserves before connecting and /stopspeaking records the measured minutes', async () => {
      const interaction = createVoiceInteraction();
      const activity: string[] = [];
      const quota = {
        reserveQuota: async () => {
          activity.push('reserve');
          return {
            allowed: true,
            reservation: { idempotencyKey: 'voice-key', reservedAmount: 10 }
          };
        },
        markQuotaAttempted: async () => {
          activity.push('attempt');
        }
      } as unknown as QuotaMiddleware;
      const record = mock((_key: string, _minutes: number) => {});
      const journal = {
        assertReady: () => {
          activity.push('journal');
        },
        record,
        flush: async () => {}
      } as unknown as VoiceQuotaJournal;
      const manager = new VoiceSessionManager({
        joinVoice: (() => {
          activity.push('join');
          return Object.assign(new EventEmitter(), { state: { status: 'ready' }, destroy: mock() });
        }) as never,
        waitForState: async connection => connection,
        createRealtimeSession: () =>
          ({
            connect: async () => {
              activity.push('connect');
            },
            disconnect: async () => 0,
            attachConnection: mock(),
            sendGreeting: mock()
          }) as never
      });
      const spies = [
        spyOn(voiceSessionManager, 'isUserSpeaking').mockImplementation(
          manager.isUserSpeaking.bind(manager)
        ),
        spyOn(voiceSessionManager, 'joinChannel').mockImplementation(
          manager.joinChannel.bind(manager)
        ),
        spyOn(voiceSessionManager, 'startSpeaking').mockImplementation(
          manager.startSpeaking.bind(manager)
        ),
        spyOn(voiceSessionManager, 'stopSpeaking').mockImplementation(
          manager.stopSpeaking.bind(manager)
        ),
        spyOn(voiceSessionManager, 'getActiveSpeakerCount').mockImplementation(
          manager.getActiveSpeakerCount.bind(manager)
        ),
        spyOn(voiceSessionManager, 'leaveGuild').mockImplementation(
          manager.leaveGuild.bind(manager)
        )
      ];
      const priorKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'synthetic-fixture';
      try {
        await new SpeakCommand(mockAdminDb, quota, journal).execute(interaction as never);
        expect(activity).toEqual(['journal', 'reserve', 'join', 'attempt', 'connect']);
        expect(record).not.toHaveBeenCalled();
        await new StopSpeakingCommand().execute(interaction as never);
        expect(record.mock.calls).toEqual([['voice-key', 1]]);
        expect(interaction._getReplies()).toContainEqual({
          content: 'Voice session ended. Silo has left the voice channel.',
          ephemeral: false
        });
      } finally {
        await manager.leaveGuild(interaction.guildId);
        for (const spy of spies) spy.mockRestore();
        if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = priorKey;
      }
    });

    test('rejects when user is not in voice channel', async () => {
      const mockMember = {
        id: '111222333',
        permissions: { has: () => true },
        roles: { cache: new Map() },
        voice: { channel: null }
      };

      const interaction = createMockInteraction({
        member: mockMember as any
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect((reply as { content: string }).content).toContain('voice channel');
    });

    test('rejects invalid channel types', async () => {
      const mockVoiceChannel = {
        id: 'voice123',
        name: 'General',
        guild: { id: 'guild123' },
        type: 0, // GuildText - invalid for voice
        permissionsFor: () => ({ has: () => true })
      };

      const mockMember = {
        id: '111222333',
        permissions: { has: () => true },
        roles: { cache: new Map() },
        voice: { channel: mockVoiceChannel }
      };

      const interaction = createMockInteraction({
        member: mockMember as any
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect((reply as { content: string }).content).toContain('voice channel');
    });
  });
});
