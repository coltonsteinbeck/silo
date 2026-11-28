import { expect, mock, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  getVoiceConnection,
  Networking,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterLibraryMethods
} from '@discordjs/voice';
import { joinSiloVoiceChannel } from '../../voice/join-voice-channel';

test.each(['server-first', 'state-first'])(
  'voice starts the handshake with %s gateway packets',
  order => {
    const guildId = '1';
    const channelId = '2';
    const destroyAdapter = mock(() => {});
    const socket = Object.assign(new EventEmitter(), { destroy: mock(() => {}) });
    const openSocket = spyOn(
      Networking.prototype as unknown as { createWebSocket: () => typeof socket },
      'createWebSocket'
    ).mockReturnValue(socket);
    let adapter: DiscordGatewayAdapterLibraryMethods | undefined;
    const connection = joinSiloVoiceChannel({
      guildId,
      channelId,
      adapterCreator: methods => {
        adapter = methods;
        return { destroy: destroyAdapter, sendPayload: () => true };
      }
    });

    try {
      if (!adapter) throw new Error('Voice adapter was not initialized');
      const voiceAdapter = adapter;
      const serverUpdate = () =>
        voiceAdapter.onVoiceServerUpdate({
          guild_id: guildId,
          endpoint: 'voice.example.invalid',
          token: 'fixture-token'
        });
      const stateUpdate = () =>
        voiceAdapter.onVoiceStateUpdate({
          guild_id: guildId,
          channel_id: channelId,
          user_id: '3',
          session_id: 'fixture-session',
          deaf: false,
          mute: false,
          self_deaf: false,
          self_mute: false,
          self_video: false,
          suppress: false,
          request_to_speak_timestamp: null
        });

      const [first, second] =
        order === 'server-first' ? [serverUpdate, stateUpdate] : [stateUpdate, serverUpdate];
      first();
      expect(connection.state.status).toBe(VoiceConnectionStatus.Signalling);
      expect(openSocket).not.toHaveBeenCalled();
      second();
      expect(connection.state.status).toBe(VoiceConnectionStatus.Connecting);
      expect(openSocket).toHaveBeenCalledTimes(1);
    } finally {
      openSocket.mockRestore();
      connection.destroy();
    }

    expect(destroyAdapter).toHaveBeenCalledTimes(1);
    expect(getVoiceConnection(guildId)).toBeUndefined();
  }
);
