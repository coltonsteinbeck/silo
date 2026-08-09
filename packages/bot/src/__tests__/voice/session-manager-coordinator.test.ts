import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { guildVoiceCoordinator } from '../../voice/guild-voice-coordinator';
import { VoiceSessionManager } from '../../voice/session-manager';

const channel = {
  id: 'voice',
  name: 'Voice',
  guild: { id: 'guild', voiceAdapterCreator: {} }
};

const connection = () =>
  Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready },
    destroy: mock(function (this: { state: { status: string } }) {
      this.state = { status: VoiceConnectionStatus.Destroyed };
    })
  });

describe('VoiceSessionManager guild voice coordination', () => {
  beforeEach(() => guildVoiceCoordinator.clear());
  afterEach(() => guildVoiceCoordinator.clear());

  test('active radio prevents speech from joining voice', async () => {
    const radio = guildVoiceCoordinator.reserveExclusive('guild', 'radio', 'music');
    if (!radio.acquired) throw new Error('reservation failed');
    guildVoiceCoordinator.commit('guild', radio.token, {});
    const joinVoice = mock(() => connection());
    const manager = new VoiceSessionManager({
      joinVoice: joinVoice as never,
      waitForState: mock(async value => value)
    });

    expect(manager.joinChannel(channel as never)).rejects.toThrow('radio playback is active');
    expect(joinVoice).not.toHaveBeenCalled();
  });

  test('failed speech connection creation immediately makes radio eligible', async () => {
    const manager = new VoiceSessionManager({
      joinVoice: mock(() => {
        throw new Error('voice join failed');
      }) as never,
      waitForState: mock(async value => value)
    });

    expect(manager.joinChannel(channel as never)).rejects.toThrow('voice join failed');
    expect(guildVoiceCoordinator.getActiveActivity('guild')).toBeNull();
    expect(guildVoiceCoordinator.reserveExclusive('guild', 'radio', 'music').acquired).toBe(true);
  });

  test('failed speech readiness destroys the connection and releases its lease', async () => {
    const created = connection();
    const manager = new VoiceSessionManager({
      joinVoice: mock(() => created) as never,
      waitForState: mock(async () => {
        throw new Error('timeout');
      })
    });

    expect(manager.joinChannel(channel as never)).rejects.toThrow('Failed to connect');
    expect(created.destroy).toHaveBeenCalledTimes(1);
    expect(guildVoiceCoordinator.getActiveActivity('guild')).toBeNull();
  });

  test('committed speech session remains reusable and releases on leave', async () => {
    const created = connection();
    const joinVoice = mock(() => created);
    const manager = new VoiceSessionManager({
      joinVoice: joinVoice as never,
      waitForState: mock(async value => value)
    });

    expect(await manager.joinChannel(channel as never)).toBe(created as never);
    expect(await manager.joinChannel(channel as never)).toBe(created as never);
    expect(joinVoice).toHaveBeenCalledTimes(1);
    expect(guildVoiceCoordinator.getActiveActivity('guild')).toMatchObject({
      type: 'speech',
      reserved: false
    });

    await manager.leaveGuild('guild');
    expect(created.destroy).toHaveBeenCalledTimes(1);
    expect(guildVoiceCoordinator.getActiveActivity('guild')).toBeNull();
  });
});
