import { ChannelType } from 'discord.js';
import { describe, expect, mock, test } from 'bun:test';
import { RadioCommand } from '../../commands/radio';

describe('RadioCommand', () => {
  test('registers required link and GuildVoice channel options without a play alias', () => {
    const command = new RadioCommand({} as never);
    const json = command.data.toJSON();

    expect(json.name).toBe('radio');
    expect(json.options?.map(option => option.name)).toEqual(['link', 'channel']);
    expect(json.options?.every(option => option.required)).toBe(true);
    expect(json.options?.find(option => option.name === 'channel')).toMatchObject({
      channel_types: [ChannelType.GuildVoice]
    });
  });

  test('fetches the selected full channel and delegates playback', async () => {
    const play = mock(async () => {});
    const command = new RadioCommand({ play } as never);
    const channel = { id: 'voice', type: ChannelType.GuildVoice };
    const interaction = {
      options: {
        getString: () => ' https://youtu.be/M7lc1UVf-VE ',
        getChannel: () => channel
      },
      guild: { channels: { fetch: mock(async () => channel) } }
    };

    await command.execute(interaction as never);
    expect(play).toHaveBeenCalledWith(interaction, 'https://youtu.be/M7lc1UVf-VE', channel);
  });

  test('rejects non-voice selections with an ephemeral no-mentions reply', async () => {
    const play = mock(async () => {});
    const reply = mock(async () => {});
    const command = new RadioCommand({ play } as never);
    await command.execute({
      options: {
        getString: () => 'https://youtu.be/M7lc1UVf-VE',
        getChannel: () => ({ id: 'text', type: ChannelType.GuildText })
      },
      guild: {},
      reply
    } as never);

    expect(play).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: 64, allowedMentions: { parse: [] } })
    );
  });

  test('delegates buttons, voice-state updates, and shutdown', async () => {
    const manager = {
      handleButtonInteraction: mock(async () => true),
      handleVoiceStateUpdate: mock(() => true),
      stopAll: mock(async () => {})
    };
    const command = new RadioCommand(manager as never);
    const button = {};
    const oldState = {};
    const newState = {};

    expect(await command.handleButtonInteraction(button as never)).toBe(true);
    expect(command.handleVoiceStateUpdate(oldState as never, newState as never)).toBe(true);
    await command.stopAll();
    expect(manager.handleButtonInteraction).toHaveBeenCalledWith(button);
    expect(manager.handleVoiceStateUpdate).toHaveBeenCalledWith(oldState, newState);
    expect(manager.stopAll).toHaveBeenCalledWith('shutdown');
  });
});
