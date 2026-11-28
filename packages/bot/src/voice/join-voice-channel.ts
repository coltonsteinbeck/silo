import { joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';

export const joinSiloVoiceChannel: typeof joinVoiceChannel = options => {
  let connection: VoiceConnection | undefined;
  connection = joinVoiceChannel({
    ...options,
    adapterCreator: methods =>
      options.adapterCreator({
        ...methods,
        onVoiceStateUpdate(packet) {
          methods.onVoiceStateUpdate(packet);
          // Backport discordjs/discord.js#11581 until the stable voice package includes it.
          if (packet.channel_id && connection?.state.status === VoiceConnectionStatus.Signalling) {
            connection.configureNetworking();
          }
        }
      })
  });
  return connection;
};
