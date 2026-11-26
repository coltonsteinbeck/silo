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

  test('a paid speaker is bounded and settled exactly once when the provider closes', async () => {
    let providerClosed: (() => void) | undefined;
    const connect = mock(async () => {});
    const disconnect = mock(async () => 1);
    const beforeConnect = mock(async () => {});
    const onEnd = mock(async (_durationMs: number) => {});
    const manager = new VoiceSessionManager({
      joinVoice: mock(() => connection()) as never,
      waitForState: mock(async value => value),
      createRealtimeSession: (_apiKey, _userId, options) => {
        providerClosed = options?.onClose;
        return { connect, disconnect } as never;
      }
    });

    await manager.joinChannel(channel as never);
    await manager.startSpeaking('guild', 'member', 'synthetic', {
      beforeConnect,
      onEnd,
      maxDurationMs: 1000
    });
    await expect(manager.joinChannel({ ...channel, id: 'other' } as never)).rejects.toThrow(
      'another channel'
    );
    providerClosed?.();
    providerClosed?.();
    await Promise.resolve();

    expect(beforeConnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(manager.hasSession('guild')).toBe(false);
  });

  test('expiry disconnects and settles the bounded paid session', async () => {
    const disconnect = mock(async () => 1);
    const onEnd = mock(async (_durationMs: number) => {});
    const manager = new VoiceSessionManager({
      joinVoice: mock(() => connection()) as never,
      waitForState: mock(async value => value),
      createRealtimeSession: () => ({ connect: async () => {}, disconnect }) as never
    });
    await manager.joinChannel(channel as never);
    await manager.startSpeaking('guild', 'member', 'synthetic', { onEnd, maxDurationMs: 1 });
    await Bun.sleep(10);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(manager.isUserSpeaking('guild', 'member')).toBe(false);
  });

  test('rejects readiness after the speaker has already stopped', async () => {
    const connecting = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    const disconnect = mock(async () => 1);
    const onEnd = mock(async (_durationMs: number) => {});
    const manager = new VoiceSessionManager({
      joinVoice: mock(() => connection()) as never,
      waitForState: mock(async value => value),
      createRealtimeSession: () =>
        ({
          connect: () => {
            connecting.resolve();
            return ready.promise;
          },
          disconnect
        }) as never
    });
    await manager.joinChannel(channel as never);

    const speaking = manager.startSpeaking('guild', 'member', 'synthetic', { onEnd });
    await connecting.promise;
    await manager.stopSpeaking('guild', 'member');
    ready.resolve();

    await expect(speaking).rejects.toThrow('Voice connection stopped before speech started');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(manager.isUserSpeaking('guild', 'member')).toBe(false);
  });

  test('the runtime records every active speaker before asynchronous shutdown', async () => {
    const disconnect = mock(async () => 0);
    const onEnd = mock((_durationMs: number) => {});
    const manager = new VoiceSessionManager({
      joinVoice: mock(() => connection()) as never,
      waitForState: mock(async value => value),
      createRealtimeSession: () => ({ connect: async () => {}, disconnect }) as never
    });
    await manager.joinChannel(channel as never);
    await manager.startSpeaking('guild', 'first', 'synthetic', { onEnd });
    await manager.startSpeaking('guild', 'second', 'synthetic', { onEnd });

    manager.stopAll();

    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(disconnect).not.toHaveBeenCalled();
    await manager.stopSpeaking('guild', 'second');
    expect(onEnd).toHaveBeenCalledTimes(2);
  });

  test('rechecks channel membership after marking quota and settles without connecting', async () => {
    let stillPresent = true;
    const connect = mock(async () => {});
    const onEnd = mock(async (_durationMs: number) => {});
    const manager = new VoiceSessionManager({
      joinVoice: mock(() => connection()) as never,
      waitForState: mock(async value => value),
      createRealtimeSession: () => ({ connect, disconnect: async () => 0 }) as never
    });
    await manager.joinChannel(channel as never);

    await expect(
      manager.startSpeaking('guild', 'member', 'synthetic', {
        beforeConnect: async () => {
          stillPresent = false;
        },
        authorizeConnection: () => {
          if (!stillPresent) throw new Error('requester left');
        },
        onEnd
      })
    ).rejects.toThrow('requester left');

    expect(connect).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(manager.hasSession('guild')).toBe(false);
  });
});
