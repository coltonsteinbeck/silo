import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import { describe, expect, mock, test } from 'bun:test';
import { GuildVoiceCoordinator } from '../../voice/guild-voice-coordinator';
import { RadioManager } from '../../voice/radio/manager';
import type {
  PreparedRadioPlayback,
  RadioSourceResolution,
  RadioTrack
} from '../../voice/radio/types';
import { RadioError } from '../../voice/radio/types';

const track = (title: string): RadioTrack => ({
  url: `https://www.youtube.com/watch?v=${title.padEnd(11, 'x').slice(0, 11)}`,
  title,
  channel: 'Channel',
  duration: '1:00',
  thumbnail: null,
  isSpotifyTrack: false
});

const resolution = (...tracks: RadioTrack[]): RadioSourceResolution => ({
  kind: tracks.length > 1 ? 'youtube-playlist' : 'youtube-video',
  displayName: tracks.length > 1 ? 'Playlist' : (tracks[0]?.title ?? 'Track'),
  tracks
});

function createHarness({
  sourceResults = new Map([['first', resolution(track('first'))]]),
  prepareError
}: {
  sourceResults?: Map<string, RadioSourceResolution>;
  prepareError?: Error;
} = {}) {
  const coordinator = new GuildVoiceCoordinator();
  const prepared: PreparedRadioPlayback[] = [];
  const processes: Array<{ kill: ReturnType<typeof mock> }> = [];
  const source = {
    classify: mock((link: string) =>
      link.startsWith('spotify-collection') ? 'spotify-collection' : 'youtube'
    ),
    resolve: mock(async (link: string) => {
      const value = sourceResults.get(link);
      if (!value) throw new Error('missing fixture');
      return value;
    }),
    preparePlayback: mock(
      async (_url: string, _options?: { signal?: AbortSignal; isLive?: boolean }) => {
        if (prepareError) throw prepareError;
        const stream = new PassThrough();
        const process = { kill: mock(() => true) };
        processes.push(process);
        const playback = {
          stream,
          type: 0,
          process,
          source: 'yt-dlp',
          detachCancellation: mock(() => {})
        } as unknown as PreparedRadioPlayback;
        prepared.push(playback);
        return playback;
      }
    ),
    createAudioResource: mock((playback: PreparedRadioPlayback) => ({
      playStream: playback.stream
    })),
    disposePlayback: mock((playback: PreparedRadioPlayback | null) => {
      if (!playback) return;
      playback.detachCancellation();
      playback.process.kill('SIGKILL');
      playback.stream.destroy();
    })
  };

  const player = Object.assign(new EventEmitter(), {
    state: { status: AudioPlayerStatus.Idle },
    play: mock(function (this: { state: { status: string } }) {
      this.state = { status: AudioPlayerStatus.Playing };
    }),
    pause: mock(function (this: { state: { status: string } }) {
      this.state = { status: AudioPlayerStatus.Paused };
      return true;
    }),
    unpause: mock(function (this: { state: { status: string } }) {
      this.state = { status: AudioPlayerStatus.Playing };
      return true;
    }),
    stop: mock(function (this: { state: { status: string } }) {
      this.state = { status: AudioPlayerStatus.Idle };
      return true;
    })
  });
  const connection = Object.assign(new EventEmitter(), {
    state: { status: VoiceConnectionStatus.Ready },
    subscribe: mock(() => ({})),
    destroy: mock(function (this: { state: { status: string } }) {
      this.state = { status: VoiceConnectionStatus.Destroyed };
    })
  });
  const runtime = {
    createPlayer: mock(() => player),
    joinVoice: mock(() => connection),
    waitForState: mock(async () => undefined)
  };
  const manager = new RadioManager({
    source: source as never,
    coordinator,
    runtime: runtime as never
  });

  let humans = true;
  const channel = {
    id: 'voice',
    name: 'Music',
    guild: { id: 'guild', voiceAdapterCreator: {} },
    members: {
      some: (predicate: (member: { user: { bot: boolean } }) => boolean) =>
        humans && predicate({ user: { bot: false } })
    }
  };
  const message = {
    id: 'player-message',
    interactionMetadata: { id: 'command-interaction' },
    edit: mock(async () => message),
    channel: { isSendable: () => false }
  };
  const makeInteraction = (id = 'command-interaction') => {
    const interaction = {
      id,
      guildId: 'guild',
      deferReply: mock(async () => undefined),
      editReply: mock(async () => message),
      deleteReply: mock(async () => undefined),
      reply: mock(async () => undefined)
    };
    return interaction;
  };
  const makeButton = (customId: string, messageId = message.id) => ({
    customId,
    guildId: 'guild',
    message: { ...message, id: messageId },
    reply: mock(async () => undefined),
    deferUpdate: mock(async () => undefined),
    editReply: mock(async () => undefined),
    followUp: mock(async () => undefined)
  });

  return {
    channel,
    connection,
    coordinator,
    makeButton,
    makeInteraction,
    manager,
    message,
    player,
    prepared,
    processes,
    runtime,
    setHumans(value: boolean) {
      humans = value;
    },
    source
  };
}

describe('RadioManager', () => {
  test('prepares audio before joining voice and commits a persistent queue', async () => {
    const harness = createHarness();
    const interaction = harness.makeInteraction();

    await harness.manager.play(interaction as never, 'first', harness.channel as never);

    expect(harness.source.preparePlayback).toHaveBeenCalledTimes(1);
    expect(harness.runtime.joinVoice).toHaveBeenCalledTimes(1);
    expect(harness.source.preparePlayback.mock.invocationCallOrder[0]).toBeLessThan(
      harness.runtime.joinVoice.mock.invocationCallOrder[0] ?? Infinity
    );
    expect(harness.manager.getQueue('guild')).toMatchObject({
      songs: [{ title: 'first' }],
      persistentMessage: { id: 'player-message' },
      isFinished: false
    });
    expect(harness.coordinator.getActiveActivity('guild')).toMatchObject({
      type: 'radio',
      reserved: false
    });
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ components: expect.any(Array), allowedMentions: { parse: [] } })
    );
  });

  test('appends to the active player without creating a second voice connection', async () => {
    const results = new Map([
      ['first', resolution(track('first'))],
      ['second', resolution(track('second'))]
    ]);
    const harness = createHarness({ sourceResults: results });
    await harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );
    const appendInteraction = harness.makeInteraction('append');

    await harness.manager.play(appendInteraction as never, 'second', harness.channel as never);

    expect(harness.manager.getQueue('guild')?.songs.map(song => song.title)).toEqual([
      'first',
      'second'
    ]);
    expect(harness.runtime.joinVoice).toHaveBeenCalledTimes(1);
    expect(harness.source.preparePlayback).toHaveBeenCalledTimes(1);
    expect(appendInteraction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Added to queue at #2') })
    );
  });

  test('fully releases a failed startup so speech can reserve immediately', async () => {
    const harness = createHarness({ prepareError: new Error('extractor failed with private URL') });
    const interaction = harness.makeInteraction();

    await harness.manager.play(interaction as never, 'first', harness.channel as never);

    expect(harness.manager.getQueue('guild')).toBeNull();
    expect(harness.runtime.joinVoice).not.toHaveBeenCalled();
    expect(harness.coordinator.getActiveActivity('guild')).toBeNull();
    expect(harness.coordinator.reserveExclusive('guild', 'speech', 'voice').acquired).toBe(true);
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: 'Failed to play audio. Please check the URL and try again.',
        allowedMentions: { parse: [] }
      })
    );
  });

  test('does not retain a pending queue when the selected channel is empty', async () => {
    const harness = createHarness();
    harness.setHumans(false);
    const interaction = harness.makeInteraction();

    await harness.manager.play(interaction as never, 'first', harness.channel as never);

    expect(harness.manager.hasActiveQueue('guild')).toBe(false);
    expect(harness.coordinator.getActiveActivity('guild')).toBeNull();
    expect(harness.source.preparePlayback).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.stringContaining('non-bot user') })
    );
  });

  test('a replacement startup cancels and rolls back superseded preparation', async () => {
    const results = new Map([
      ['first', resolution(track('first'))],
      ['second', resolution(track('second'))]
    ]);
    const harness = createHarness({ sourceResults: results });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => {
      firstStarted = resolve;
    });
    let calls = 0;
    harness.source.preparePlayback.mockImplementation(async (_url, options) => {
      calls += 1;
      if (calls > 1) {
        const stream = new PassThrough();
        const process = { kill: mock(() => true) };
        const playback = {
          stream,
          type: 0,
          process,
          source: 'yt-dlp',
          detachCancellation: mock(() => {})
        } as unknown as PreparedRadioPlayback;
        harness.prepared.push(playback);
        harness.processes.push(process);
        return playback;
      }
      firstStarted();
      return new Promise((_, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () => reject(new RadioError('PLAYBACK_CANCELLED', 'superseded')),
          { once: true }
        );
      });
    });

    const first = harness.manager.play(
      harness.makeInteraction('first-command') as never,
      'first',
      harness.channel as never
    );
    await started;
    const second = harness.manager.play(
      harness.makeInteraction('second-command') as never,
      'second',
      harness.channel as never
    );
    await Promise.all([first, second]);

    expect(harness.manager.getQueue('guild')?.songs[0]?.title).toBe('second');
    expect(harness.runtime.joinVoice).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getActiveActivity('guild')).toMatchObject({ type: 'radio' });
  });

  test('blocks radio while a committed speech session owns the guild', async () => {
    const harness = createHarness();
    const speech = harness.coordinator.reserveExclusive('guild', 'speech', 'voice');
    if (!speech.acquired) throw new Error('reservation failed');
    harness.coordinator.commit('guild', speech.token, {});
    const interaction = harness.makeInteraction();

    await harness.manager.play(interaction as never, 'first', harness.channel as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('voice chat is already active') })
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(harness.source.resolve).not.toHaveBeenCalled();
  });

  test('rejects controls from an old player message without mutating the queue', async () => {
    const harness = createHarness();
    await harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );
    const stale = harness.makeButton('radio:pause', 'old-message');

    expect(await harness.manager.handleButtonInteraction(stale as never)).toBe(true);
    expect(stale.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('stale') })
    );
    expect(harness.player.pause).not.toHaveBeenCalled();
  });

  test('cycles repeat controls and pauses the current player', async () => {
    const harness = createHarness();
    await harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );

    const repeat = harness.makeButton('radio:repeat');
    await harness.manager.handleButtonInteraction(repeat as never);
    expect(harness.manager.getQueue('guild')?.repeatMode).toBe(1);

    const pause = harness.makeButton('radio:pause');
    await harness.manager.handleButtonInteraction(pause as never);
    expect(harness.manager.getQueue('guild')?.isPaused).toBe(true);
    expect(harness.player.pause).toHaveBeenCalledTimes(1);
  });

  test('returns the no-next response without deferring the button', async () => {
    const harness = createHarness();
    await harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );
    const skip = harness.makeButton('radio:skip');

    await harness.manager.handleButtonInteraction(skip as never);

    expect(skip.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'No more songs in the queue!', flags: 64 })
    );
    expect(skip.deferUpdate).not.toHaveBeenCalled();
  });

  test('Stop tears down the player, stream, child process, connection, queue, and lease', async () => {
    const harness = createHarness();
    await harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );
    const stop = harness.makeButton('radio:stop');

    await harness.manager.handleButtonInteraction(stop as never);

    expect(harness.manager.getQueue('guild')).toBeNull();
    expect(harness.coordinator.getActiveActivity('guild')).toBeNull();
    expect(harness.player.stop).toHaveBeenCalled();
    expect(harness.connection.destroy).toHaveBeenCalled();
    expect(harness.processes[0]?.kill).toHaveBeenCalledWith('SIGKILL');
    expect(harness.prepared[0]?.stream.destroyed).toBe(true);
    expect(stop.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [], allowedMentions: { parse: [] } })
    );
  });

  test('disconnects after the last human leaves the radio channel', async () => {
    const harness = createHarness();
    await harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );
    harness.setHumans(false);

    expect(
      harness.manager.handleVoiceStateUpdate(
        { guild: { id: 'guild' }, channelId: 'voice' } as never,
        { guild: { id: 'guild' }, channelId: null } as never
      )
    ).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(harness.manager.getQueue('guild')).toBeNull();
    expect(harness.connection.destroy).toHaveBeenCalled();
  });

  test('stopAll is idempotent and leaves no queue or guild lease', async () => {
    const harness = createHarness();
    await harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );

    await harness.manager.stopAll('test');
    await harness.manager.stopAll('test-again');

    expect(harness.manager.getQueue('guild')).toBeNull();
    expect(harness.coordinator.getActiveActivity('guild')).toBeNull();
    expect(harness.connection.destroy).toHaveBeenCalledTimes(1);
  });

  test('shutdown aborts source resolution and prevents a late voice join', async () => {
    const harness = createHarness();
    harness.source.resolve.mockImplementation(
      async (_link: string, signal?: AbortSignal): Promise<RadioSourceResolution> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new RadioError('PLAYBACK_CANCELLED', 'shutdown')),
            { once: true }
          );
        })
    );
    const operation = harness.manager.play(
      harness.makeInteraction() as never,
      'first',
      harness.channel as never
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    await harness.manager.stopAll('shutdown');
    await operation;

    expect(harness.runtime.joinVoice).not.toHaveBeenCalled();
    expect(harness.manager.hasActiveQueue('guild')).toBe(false);
    expect(harness.coordinator.getActiveActivity('guild')).toBeNull();
  });
});
