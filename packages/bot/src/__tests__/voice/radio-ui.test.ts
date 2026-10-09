import { describe, expect, test } from 'bun:test';
import {
  createPersistentRadioPayload,
  createQueueOverview,
  createRadioControls
} from '../../voice/radio/ui';
import type { RadioQueue, RadioTrack } from '../../voice/radio/types';

const tracks: RadioTrack[] = [
  {
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    title: 'Current',
    channel: 'Channel',
    duration: '1:00',
    thumbnail: 'https://i.ytimg.com/current.jpg',
    isSpotifyTrack: false
  },
  {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'Spotify Track',
    channel: 'Artist',
    duration: '2:00',
    thumbnail: null,
    isSpotifyTrack: true,
    originalSpotifyUrl: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'
  }
];

const queue = (overrides: Partial<RadioQueue> = {}): RadioQueue =>
  ({
    songs: tracks,
    currentIndex: 0,
    isPaused: false,
    isFinished: false,
    repeatMode: 0,
    ...overrides
  }) as RadioQueue;

const serialize = (value: unknown): any => JSON.parse(JSON.stringify(value));

describe('radio Discord UI', () => {
  test('uses the radio namespace for every active player control', () => {
    const rows = serialize(createRadioControls(true, false, 0));
    expect(
      rows.flatMap((row: { components: Array<{ custom_id: string }> }) =>
        row.components.map(component => component.custom_id)
      )
    ).toEqual([
      'radio:pause',
      'radio:skip',
      'radio:stop',
      'radio:queue',
      'radio:repeat',
      'radio:previous'
    ]);
  });

  test('renders Now Playing with queue preview and disabled mention parsing', () => {
    const payload = createPersistentRadioPayload(queue());
    const json = serialize(payload);
    expect(json.embeds[0]).toMatchObject({
      title: '🎵 Now Playing',
      description: '**Current**'
    });
    expect(json.components).toHaveLength(2);
    expect(json.allowedMentions).toEqual({ parse: [] });
  });

  test('renders paused and repeat-one state in the persistent player', () => {
    const payload = createPersistentRadioPayload(queue({ isPaused: true, repeatMode: 1 }));
    const json = serialize(payload);
    expect(json.embeds[0].title).toBe('⏸️ Paused 🔂');
    const repeat = json.components[1].components[1];
    expect(repeat?.label).toBe('🔂 One');
  });

  test('renders the orange finished state with one disconnect control', () => {
    const payload = createPersistentRadioPayload(queue({ isFinished: true }));
    const json = serialize(payload);
    const embed = json.embeds[0];
    expect(embed?.title).toBe('🔚 Queue Finished');
    expect(embed?.color).toBe(0xff9900);
    expect(json.components[0].components[0]).toMatchObject({
      custom_id: 'radio:stop',
      label: '⏹️ Disconnect'
    });
  });

  test('renders an ephemeral full queue with current, recent, upcoming, and statistics', () => {
    const payload = createQueueOverview(
      queue({ songs: [tracks[0]!, tracks[1]!, tracks[0]!], currentIndex: 1 })
    );
    const json = serialize(payload);
    expect(json.embeds[0].title).toBe('📋 Current Queue');
    expect(json.embeds[0].fields.map((field: { name: string }) => field.name)).toEqual([
      '📊 Queue Stats',
      '⏱️ Status',
      '🎵 Spotify Songs',
      '🎵 Currently Playing',
      '⏮️ Recently Played',
      '🔜 Up Next'
    ]);
    expect(json.flags).toBe(64);
    expect(json.allowedMentions).toEqual({ parse: [] });
  });
});
