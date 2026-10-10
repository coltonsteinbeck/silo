import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, mock, test } from 'bun:test';
import {
  MAX_RADIO_QUEUE_TRACKS,
  RadioSourceResolver,
  analyzeYouTubeUrl
} from '../../voice/radio/source';
import { RadioError } from '../../voice/radio/types';

const VIDEO_ID = 'M7lc1UVf-VE';
const PLAYLIST_ID = 'PL1234567890';
const SPOTIFY_ID = '4cOdK2wGLETKBW3PvgPWqT';

describe('radio source validation', () => {
  test.each([
    [`https://www.youtube.com/watch?v=${VIDEO_ID}`, 'video'],
    [`https://youtu.be/${VIDEO_ID}`, 'video'],
    [`https://m.youtube.com/shorts/${VIDEO_ID}`, 'video'],
    [`https://youtube.com/embed/${VIDEO_ID}`, 'video'],
    [`https://www.youtube.com/live/${VIDEO_ID}`, 'livestream'],
    [`https://music.youtube.com/playlist?list=${PLAYLIST_ID}`, 'playlist'],
    [`https://www.youtube.com/watch?v=${VIDEO_ID}&list=${PLAYLIST_ID}`, 'playlist']
  ])('accepts supported YouTube form %s', (url, type) => {
    expect(analyzeYouTubeUrl(url)).toMatchObject({ isValid: true, type });
  });

  test.each([
    `http://youtube.com/watch?v=${VIDEO_ID}`,
    `https://user:pass@youtube.com/watch?v=${VIDEO_ID}`,
    `https://youtube.com:8443/watch?v=${VIDEO_ID}`,
    `https://youtube.example/watch?v=${VIDEO_ID}`,
    `https://youtube.com.evil.test/watch?v=${VIDEO_ID}`,
    'https://youtube.com/watch?v=too-short',
    `https://youtube.com/watch?v=${VIDEO_ID}&v=abcdefghijk`,
    'https://youtube.com/playlist?list=bad',
    `https://youtu.be/${VIDEO_ID}/extra`
  ])('rejects unsafe or malformed YouTube URL %s', url => {
    expect(analyzeYouTubeUrl(url).isValid).toBe(false);
  });

  test('classifies Spotify tracks and collections without permitting arbitrary hosts', () => {
    const resolver = new RadioSourceResolver();
    expect(resolver.classify(`https://open.spotify.com/track/${SPOTIFY_ID}`)).toBe('spotify-track');
    expect(resolver.classify(`https://open.spotify.com/album/${SPOTIFY_ID}`)).toBe(
      'spotify-collection'
    );
    expect(resolver.classify(`https://spotify.com/playlist/${SPOTIFY_ID}`)).toBe(
      'spotify-collection'
    );
    expect(resolver.classify(`https://open.spotify.com:444/track/${SPOTIFY_ID}`)).toBe('invalid');
    expect(resolver.classify(`https://open.spotify.com.evil.test/track/${SPOTIFY_ID}`)).toBe(
      'invalid'
    );
  });

  test('reliably rejects Spotify collections instead of fabricating tracks', async () => {
    const resolver = new RadioSourceResolver();
    expect(resolver.resolve(`https://open.spotify.com/album/${SPOTIFY_ID}`)).rejects.toMatchObject({
      code: 'SPOTIFY_COLLECTION_UNSUPPORTED'
    });
  });

  test('normalizes YouTube metadata through the bounded yt-dlp fallback', async () => {
    const runYtDlp = mock(async () => ({
      id: VIDEO_ID,
      title: 'Pinned Fixture',
      uploader: 'YouTube Developers',
      duration_string: '0:30',
      thumbnail: 'https://i.ytimg.com/example.jpg',
      is_live: false
    }));
    const resolver = new RadioSourceResolver({
      playDl: { yt_validate: () => false } as never,
      runYtDlp: runYtDlp as never
    });

    const result = await resolver.resolve(`https://youtu.be/${VIDEO_ID}`);
    expect(result).toEqual({
      kind: 'youtube-video',
      displayName: 'Pinned Fixture',
      tracks: [
        {
          url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
          title: 'Pinned Fixture',
          channel: 'YouTube Developers',
          duration: '0:30',
          thumbnail: 'https://i.ytimg.com/example.jpg',
          isSpotifyTrack: false,
          isLive: false
        }
      ]
    });
    expect(runYtDlp).toHaveBeenCalledTimes(1);
  });

  test('filters malformed playlist entries and canonicalizes accepted tracks', async () => {
    const runYtDlp = mock(async () => ({
      title: 'Playlist',
      entries: [
        { id: VIDEO_ID, title: 'Good', uploader: 'Channel', duration_string: '1:00' },
        { id: 'too-short', title: 'Bad' },
        {
          id: 'abcdefghijk',
          title: 'Wrong origin',
          webpage_url: 'https://example.test/watch?v=abcdefghijk'
        }
      ]
    }));
    const resolver = new RadioSourceResolver({ runYtDlp: runYtDlp as never });

    const result = await resolver.resolve(`https://www.youtube.com/playlist?list=${PLAYLIST_ID}`);
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]?.url).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
  });

  test('rejects playlists exceeding the 1,000-track queue cap', async () => {
    const entries = Array.from({ length: MAX_RADIO_QUEUE_TRACKS + 1 }, () => ({ id: VIDEO_ID }));
    const resolver = new RadioSourceResolver({
      runYtDlp: (async () => ({ title: 'Too Large', entries })) as never
    });

    expect(
      resolver.resolve(`https://youtube.com/playlist?list=${PLAYLIST_ID}`)
    ).rejects.toMatchObject({ code: 'MUSIC_QUEUE_CAPACITY' });
  });

  test('maps a real Spotify track to a canonical YouTube result and keeps Spotify styling', async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        title: 'Never Gonna Give You Up by Rick Astley',
        thumbnail_url: 'https://image-cdn.spotify.test/cover.jpg'
      })
    );
    const resolver = new RadioSourceResolver({
      fetchImpl: fetchImpl as never,
      playDl: {
        search: async () => [
          {
            url: `https://youtu.be/${VIDEO_ID}`,
            title: 'YouTube result',
            channel: { name: 'Result Channel' },
            durationInSec: 212,
            thumbnails: [{ url: 'https://i.ytimg.com/result.jpg' }]
          }
        ]
      } as never
    });

    const result = await resolver.resolve(`https://open.spotify.com/track/${SPOTIFY_ID}`);
    expect(result.kind).toBe('spotify-track');
    expect(result.tracks[0]).toMatchObject({
      title: 'Never Gonna Give You Up',
      channel: 'Rick Astley',
      isSpotifyTrack: true,
      originalSpotifyUrl: `https://open.spotify.com/track/${SPOTIFY_ID}`,
      url: `https://www.youtube.com/watch?v=${VIDEO_ID}`
    });
  });

  test('prepares first bytes before returning and keeps livestream transport flags', async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: new PassThrough(),
      kill: mock(() => true)
    });
    let spawnedArgs: readonly string[] = [];
    const spawnProcess = mock((_executable: string, args: readonly string[]) => {
      spawnedArgs = args;
      queueMicrotask(() => stdout.write(Buffer.from('audio')));
      return child;
    });
    const resolver = new RadioSourceResolver({
      spawnProcess: spawnProcess as never,
      resolveExecutable: () => '/verified/yt-dlp'
    });

    const playback = await resolver.preparePlayback(`https://www.youtube.com/watch?v=${VIDEO_ID}`, {
      isLive: true
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnedArgs).toContain('--hls-use-mpegts');
    expect(spawnedArgs.at(-1)).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    resolver.disposePlayback(playback);
    expect(child.kill).toHaveBeenCalled();
  });

  test('honors cancellation before spawning a transport', async () => {
    const spawnProcess = mock(() => {
      throw new Error('must not spawn');
    });
    const resolver = new RadioSourceResolver({ spawnProcess: spawnProcess as never });
    const controller = new AbortController();
    controller.abort();

    try {
      await resolver.preparePlayback(`https://youtube.com/watch?v=${VIDEO_ID}`, {
        signal: controller.signal
      });
      throw new Error('expected cancellation');
    } catch (error) {
      expect(error).toBeInstanceOf(RadioError);
      expect((error as RadioError).code).toBe('PLAYBACK_CANCELLED');
    }
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
