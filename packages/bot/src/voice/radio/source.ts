import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { logger } from '@silo/core';
import playdl from 'play-dl';
import youtubeDlExec, { type Flags, type Payload } from 'youtube-dl-exec';
import { resolveYtDlpExecutable } from '../../runtime/yt-dlp';
import { withLangfuseSpan } from '../../telemetry/langfuse-client';
import {
  RadioError,
  type PreparedRadioPlayback,
  type RadioSourceResolution,
  type RadioTrack
} from './types';

export const MAX_RADIO_QUEUE_TRACKS = 1_000;
export const RADIO_QUEUE_CAPACITY_MESSAGE =
  '❌ Radio queues are limited to 1,000 tracks. Please choose a smaller playlist or clear the current queue.';
export const SPOTIFY_COLLECTION_UNSUPPORTED_MESSAGE =
  '❌ Spotify albums and playlists are not supported yet. Use an individual Spotify track or a YouTube playlist instead.';

const AUDIO_START_TIMEOUT_MS = 15_000;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;
const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{10,64}$/;
const YOUTUBE_LONG_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com'
]);

export interface YouTubeUrlAnalysis {
  isValid: boolean;
  type: 'video' | 'playlist' | 'livestream' | 'unknown';
  videoId: string | null;
  playlistId: string | null;
}

interface SpotifyUrlAnalysis {
  type: 'track' | 'album' | 'playlist';
  id: string;
}

interface YtDlpEntry {
  id?: unknown;
  title?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration_string?: unknown;
  thumbnail?: unknown;
  webpage_url?: unknown;
}

interface YtDlpCollection {
  title?: unknown;
  uploader?: unknown;
  thumbnail?: unknown;
  entries?: unknown;
}

export interface RadioSourceDependencies {
  fetchImpl: typeof fetch;
  spawnProcess: typeof spawn;
  resolveExecutable: () => string;
  playDl: typeof playdl;
  runYtDlp: (url: string, flags?: Flags) => Promise<Payload>;
}

const cleanText = (value: unknown, fallback: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
};

const cleanOptionalText = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
};

const isSecureProviderUrl = (parsed: URL): boolean =>
  parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port;

export function analyzeYouTubeUrl(value: string): YouTubeUrlAnalysis {
  const invalid: YouTubeUrlAnalysis = {
    isValid: false,
    type: 'unknown',
    videoId: null,
    playlistId: null
  };

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return invalid;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !isSecureProviderUrl(parsed) ||
    (!YOUTUBE_LONG_HOSTS.has(hostname) && hostname !== 'youtu.be')
  ) {
    return invalid;
  }

  const listValues = parsed.searchParams.getAll('list');
  const playlistId = listValues.length === 1 ? (listValues[0] ?? null) : null;
  const validPlaylist = Boolean(playlistId && YOUTUBE_PLAYLIST_ID_PATTERN.test(playlistId));
  if (listValues.length > 0 && !validPlaylist) {
    return invalid;
  }

  if (hostname === 'youtu.be') {
    const match = parsed.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/);
    if (!match?.[1]) return invalid;
    return {
      isValid: true,
      type: validPlaylist ? 'playlist' : 'video',
      videoId: match[1],
      playlistId
    };
  }

  if (/^\/playlist\/?$/.test(parsed.pathname)) {
    if (!validPlaylist) return invalid;
    return {
      isValid: true,
      type: 'playlist',
      videoId: null,
      playlistId
    };
  }

  if (/^\/watch\/?$/.test(parsed.pathname)) {
    const videoValues = parsed.searchParams.getAll('v');
    if (videoValues.length !== 1 || !YOUTUBE_VIDEO_ID_PATTERN.test(videoValues[0] ?? '')) {
      return invalid;
    }
    return {
      isValid: true,
      type: validPlaylist ? 'playlist' : 'video',
      videoId: videoValues[0] ?? null,
      playlistId
    };
  }

  const routeMatch = parsed.pathname.match(/^\/(live|embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/);
  if (!routeMatch?.[2] || validPlaylist) return invalid;
  return {
    isValid: true,
    type: routeMatch[1] === 'live' ? 'livestream' : 'video',
    videoId: routeMatch[2],
    playlistId: null
  };
}

function analyzeSpotifyUrl(value: string): SpotifyUrlAnalysis | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    !isSecureProviderUrl(parsed) ||
    (hostname !== 'spotify.com' && hostname !== 'open.spotify.com')
  ) {
    return null;
  }

  const match = parsed.pathname.match(/^\/(track|album|playlist)\/([A-Za-z0-9]+)\/?$/);
  if (!match?.[1] || !match[2] || !SPOTIFY_ID_PATTERN.test(match[2])) {
    return null;
  }

  return {
    type: match[1] as SpotifyUrlAnalysis['type'],
    id: match[2]
  };
}

const requireYouTubeUrl = (
  value: string,
  allowedTypes: YouTubeUrlAnalysis['type'][]
): YouTubeUrlAnalysis => {
  const analysis = analyzeYouTubeUrl(value);
  if (!analysis.isValid || !allowedTypes.includes(analysis.type)) {
    throw new RadioError('INVALID_MEDIA_URL', 'Invalid YouTube media URL.');
  }
  return analysis;
};

export const canonicalYouTubeVideoUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${videoId}`;

const formatDuration = (seconds: number | undefined): string => {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return 'Unknown';
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
};

const decodeBasicHtmlEntities = (value: string): string =>
  value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');

const createDefaultDependencies = (): RadioSourceDependencies => {
  let runner: ReturnType<typeof youtubeDlExec.create> | null = null;
  const getRunner = () => {
    runner ??= youtubeDlExec.create(resolveYtDlpExecutable());
    return runner;
  };

  return {
    fetchImpl: fetch,
    spawnProcess: spawn,
    resolveExecutable: resolveYtDlpExecutable,
    playDl: playdl,
    runYtDlp: async (url, flags) => getRunner()(url, flags)
  };
};

export class RadioSourceResolver {
  private readonly dependencies: RadioSourceDependencies;

  constructor(dependencies: Partial<RadioSourceDependencies> = {}) {
    this.dependencies = { ...createDefaultDependencies(), ...dependencies };
  }

  classify(value: string): 'youtube' | 'spotify-track' | 'spotify-collection' | 'invalid' {
    const spotify = analyzeSpotifyUrl(value);
    if (spotify?.type === 'track') return 'spotify-track';
    if (spotify) return 'spotify-collection';
    return analyzeYouTubeUrl(value).isValid ? 'youtube' : 'invalid';
  }

  async resolve(value: string, signal?: AbortSignal): Promise<RadioSourceResolution> {
    const sourceKind = this.classify(value);
    return withLangfuseSpan(
      {
        name: 'radio.resolve-source',
        input: { sourceKind },
        metadata: { sourceKind }
      },
      async observation => {
        try {
          if (signal?.aborted) {
            throw new RadioError('PLAYBACK_CANCELLED', 'Radio source resolution was cancelled.');
          }

          let result: RadioSourceResolution;
          if (sourceKind === 'spotify-collection') {
            throw new RadioError(
              'SPOTIFY_COLLECTION_UNSUPPORTED',
              SPOTIFY_COLLECTION_UNSUPPORTED_MESSAGE
            );
          }
          if (sourceKind === 'spotify-track') {
            result = await this.resolveSpotifyTrack(value, signal);
          } else if (sourceKind === 'youtube') {
            const analysis = analyzeYouTubeUrl(value);
            result =
              analysis.type === 'playlist'
                ? await this.resolveYouTubePlaylist(analysis)
                : await this.resolveYouTubeVideo(analysis);
          } else {
            throw new RadioError(
              'INVALID_MEDIA_URL',
              'Please provide a valid YouTube or Spotify track URL.'
            );
          }

          if (signal?.aborted) {
            throw new RadioError('PLAYBACK_CANCELLED', 'Radio source resolution was cancelled.');
          }

          observation?.update({
            output: { sourceKind: result.kind, trackCount: result.tracks.length }
          });
          return result;
        } catch (error) {
          observation?.update({
            output: {
              status: 'failed',
              code: error instanceof RadioError ? error.code : 'SOURCE_RESOLUTION_FAILED'
            },
            level: 'ERROR'
          });
          throw error;
        }
      }
    );
  }

  private async resolveYouTubeVideo(analysis: YouTubeUrlAnalysis): Promise<RadioSourceResolution> {
    if (!analysis.videoId) {
      throw new RadioError('INVALID_MEDIA_URL', 'Invalid YouTube video URL.');
    }
    const canonicalUrl = canonicalYouTubeVideoUrl(analysis.videoId);
    const info = await this.getVideoInfo(canonicalUrl);
    return {
      kind: 'youtube-video',
      displayName: info.title,
      tracks: [
        {
          url: canonicalUrl,
          title: info.title,
          channel: info.channel,
          duration: info.isLive ? '🔴 LIVE' : info.duration,
          thumbnail: info.thumbnail,
          isSpotifyTrack: false,
          isLive: info.isLive || analysis.type === 'livestream'
        }
      ]
    };
  }

  private async getVideoInfo(url: string): Promise<{
    title: string;
    channel: string;
    duration: string;
    thumbnail: string | null;
    isLive: boolean;
  }> {
    requireYouTubeUrl(url, ['video', 'livestream']);
    try {
      if (this.dependencies.playDl.yt_validate(url) !== 'video') {
        throw new Error('play-dl rejected the canonical URL');
      }
      const info = await this.dependencies.playDl.video_info(url);
      const details = info.video_details;
      return {
        title: cleanText(details.title, 'Unknown Title'),
        channel: cleanText(details.channel?.name, 'Unknown'),
        duration: formatDuration(details.durationInSec),
        thumbnail: cleanOptionalText(details.thumbnails[0]?.url),
        isLive: Boolean(details.live)
      };
    } catch {
      logger.warn('[RadioSourceResolver] play-dl metadata lookup failed; using yt-dlp');
      const info = await this.dependencies.runYtDlp(url, {
        dumpSingleJson: true,
        noWarnings: true,
        skipDownload: true
      });
      return {
        title: cleanText(info.title, 'Unknown Title'),
        channel: cleanText(info.uploader || info.channel, 'Unknown'),
        duration: cleanText(info.duration_string, 'Unknown'),
        thumbnail: cleanOptionalText(info.thumbnail),
        isLive: Boolean(info.is_live)
      };
    }
  }

  private async resolveYouTubePlaylist(
    analysis: YouTubeUrlAnalysis
  ): Promise<RadioSourceResolution> {
    if (!analysis.playlistId) {
      throw new RadioError('INVALID_MEDIA_URL', 'Invalid YouTube playlist URL.');
    }
    const canonicalUrl = `https://www.youtube.com/playlist?list=${analysis.playlistId}`;
    const payload = (await this.dependencies.runYtDlp(canonicalUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      flatPlaylist: true,
      playlistEnd: MAX_RADIO_QUEUE_TRACKS + 1,
      skipDownload: true
    })) as unknown as YtDlpCollection;
    const entries = Array.isArray(payload.entries) ? (payload.entries as YtDlpEntry[]) : [];
    if (entries.length > MAX_RADIO_QUEUE_TRACKS) {
      throw new RadioError('MUSIC_QUEUE_CAPACITY', RADIO_QUEUE_CAPACITY_MESSAGE);
    }

    const tracks = entries.flatMap<RadioTrack>(entry => {
      const videoId = typeof entry.id === 'string' ? entry.id : '';
      if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return [];
      if (entry.webpage_url !== undefined && entry.webpage_url !== null) {
        const webpageAnalysis = analyzeYouTubeUrl(String(entry.webpage_url));
        if (!webpageAnalysis.isValid || webpageAnalysis.videoId !== videoId) return [];
      }

      return [
        {
          url: canonicalYouTubeVideoUrl(videoId),
          title: cleanText(entry.title, 'Unknown Title'),
          channel: cleanText(entry.uploader || entry.channel, 'Unknown Channel'),
          duration: cleanText(entry.duration_string, 'Unknown'),
          thumbnail: cleanOptionalText(entry.thumbnail),
          isSpotifyTrack: false
        }
      ];
    });
    if (tracks.length === 0) {
      throw new RadioError('INVALID_MEDIA_URL', 'That YouTube playlist is empty or unavailable.');
    }

    return {
      kind: 'youtube-playlist',
      displayName: cleanText(payload.title, 'YouTube Playlist'),
      tracks
    };
  }

  private async resolveSpotifyTrack(
    value: string,
    signal?: AbortSignal
  ): Promise<RadioSourceResolution> {
    const spotify = analyzeSpotifyUrl(value);
    if (!spotify || spotify.type !== 'track') {
      throw new RadioError('INVALID_MEDIA_URL', 'Invalid Spotify track URL.');
    }

    const canonicalSpotifyUrl = `https://open.spotify.com/track/${spotify.id}`;
    const oEmbedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(canonicalSpotifyUrl)}`;
    let title = '';
    let artist = '';
    let thumbnail: string | null = null;

    try {
      const response = await this.dependencies.fetchImpl(oEmbedUrl, { signal });
      if (response.ok) {
        const data = (await response.json()) as { title?: unknown; thumbnail_url?: unknown };
        const rawTitle = cleanText(data.title, '');
        thumbnail = cleanOptionalText(data.thumbnail_url);
        const parts = rawTitle.split(' by ');
        if (parts.length >= 2) {
          title = parts.shift()?.trim() ?? '';
          artist = parts.join(' by ').trim();
        } else {
          title = rawTitle;
        }
      }
    } catch {
      logger.warn('[RadioSourceResolver] Spotify oEmbed lookup failed');
    }

    if (!artist || !title) {
      try {
        const response = await this.dependencies.fetchImpl(canonicalSpotifyUrl, {
          signal,
          headers: { 'User-Agent': 'Mozilla/5.0 SiloRadio/1.0' }
        });
        if (response.ok) {
          const html = await response.text();
          const description = html.match(
            /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i
          )?.[1];
          if (description) {
            const parts = decodeBasicHtmlEntities(description).split(' · ');
            title ||= parts[0]?.trim() ?? '';
            artist ||= parts[1]?.trim() ?? '';
          }
        }
      } catch {
        logger.warn('[RadioSourceResolver] Spotify page metadata fallback failed');
      }
    }

    if (!title) {
      throw new RadioError('INVALID_MEDIA_URL', 'Spotify could not provide track metadata.');
    }

    const query = [artist, title].filter(Boolean).join(' ');
    const result = (await this.searchYouTube(query, 1))[0];
    if (!result) {
      throw new RadioError(
        'INVALID_MEDIA_URL',
        'No playable YouTube match was found for that Spotify track.'
      );
    }

    const track: RadioTrack = {
      ...result,
      title,
      channel: artist || result.channel,
      thumbnail: thumbnail || result.thumbnail,
      isSpotifyTrack: true,
      originalSpotifyUrl: canonicalSpotifyUrl
    };
    return {
      kind: 'spotify-track',
      displayName: title,
      tracks: [track]
    };
  }

  private async searchYouTube(query: string, limit: number): Promise<RadioTrack[]> {
    try {
      const results = await this.dependencies.playDl.search(query, {
        limit,
        source: { youtube: 'video' }
      });
      return results.flatMap<RadioTrack>(video => {
        const analysis = analyzeYouTubeUrl(video.url);
        if (!analysis.isValid || !analysis.videoId || analysis.type === 'playlist') return [];
        return [
          {
            url: canonicalYouTubeVideoUrl(analysis.videoId),
            title: cleanText(video.title, 'Unknown Title'),
            channel: cleanText(video.channel?.name, 'Unknown'),
            duration: formatDuration(video.durationInSec),
            thumbnail: cleanOptionalText(video.thumbnails[0]?.url),
            isSpotifyTrack: false
          }
        ];
      });
    } catch {
      logger.warn('[RadioSourceResolver] play-dl search failed; using yt-dlp');
      const result = (await this.dependencies.runYtDlp(`ytsearch${limit}:${query}`, {
        dumpSingleJson: true,
        noWarnings: true,
        skipDownload: true,
        flatPlaylist: true
      })) as unknown as YtDlpCollection;
      const entries = Array.isArray(result.entries)
        ? (result.entries as YtDlpEntry[])
        : ([result] as YtDlpEntry[]);
      return entries.flatMap<RadioTrack>(entry => {
        const videoId = typeof entry.id === 'string' ? entry.id : '';
        if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return [];
        return [
          {
            url: canonicalYouTubeVideoUrl(videoId),
            title: cleanText(entry.title, 'Unknown Title'),
            channel: cleanText(entry.uploader || entry.channel, 'Unknown'),
            duration: cleanText(entry.duration_string, 'Unknown'),
            thumbnail: cleanOptionalText(entry.thumbnail),
            isSpotifyTrack: false
          }
        ];
      });
    }
  }

  async preparePlayback(
    url: string,
    options: { signal?: AbortSignal; isLive?: boolean } = {}
  ): Promise<PreparedRadioPlayback> {
    const { signal, isLive = false } = options;
    if (signal?.aborted) {
      throw new RadioError('PLAYBACK_CANCELLED', 'Radio playback preparation was cancelled.');
    }
    const analysis = requireYouTubeUrl(url, ['video', 'livestream']);
    if (!analysis.videoId) {
      throw new RadioError('INVALID_MEDIA_URL', 'Invalid YouTube video URL.');
    }
    const normalizedUrl = canonicalYouTubeVideoUrl(analysis.videoId);
    const args = [
      '-f',
      'bestaudio/best',
      '-o',
      '-',
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '--retries',
      '3',
      '--fragment-retries',
      '3',
      '--buffer-size',
      '16K'
    ];
    if (isLive || analysis.type === 'livestream') {
      args.push('--force-ipv4', '--no-part', '--hls-use-mpegts');
    }
    args.push(normalizedUrl);

    const child = this.dependencies.spawnProcess(this.dependencies.resolveExecutable(), args, {
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams;
    let producedAudio = false;
    let detachCancellation: () => void = () => undefined;

    child.on('error', () => {
      logger.error('[RadioSourceResolver] yt-dlp process failed');
      if (producedAudio && !child.stdout.destroyed) {
        child.stdout.destroy(new Error('Radio source process failed.'));
      }
    });
    child.stderr.on('data', data => {
      if (/ERROR|403/i.test(String(data))) {
        logger.warn('[RadioSourceResolver] yt-dlp reported a playback error');
      }
    });
    child.stdout.on('error', () => {
      logger.error('[RadioSourceResolver] yt-dlp audio stream failed');
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          child.stdout.off('readable', ready);
          child.stdout.off('error', fail);
          child.stdout.off('end', endedWithoutAudio);
          child.stdout.off('close', endedWithoutAudio);
          child.off('error', fail);
        };
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const fail = () =>
          finish(() => reject(new Error('YouTube playback temporarily unavailable.')));
        const ready = () => {
          if (child.stdout.readableLength <= 0) return;
          finish(() => {
            producedAudio = true;
            resolve();
          });
        };
        const endedWithoutAudio = () => {
          if (!producedAudio) fail();
        };
        const onAbort = () => {
          finish(() =>
            reject(
              new RadioError('PLAYBACK_CANCELLED', 'Radio playback preparation was cancelled.')
            )
          );
          this.disposeProcess(child, child.stdout);
        };
        detachCancellation = () => signal?.removeEventListener('abort', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(fail, AUDIO_START_TIMEOUT_MS);
        timer.unref?.();
        child.stdout.once('readable', ready);
        child.stdout.once('error', fail);
        child.stdout.once('end', endedWithoutAudio);
        child.stdout.once('close', endedWithoutAudio);
        child.once('error', fail);
        if (signal?.aborted) onAbort();
        else if (child.stdout.readableLength > 0) queueMicrotask(ready);
      });
    } catch (error) {
      detachCancellation();
      this.disposeProcess(child, child.stdout);
      throw error;
    }

    return {
      stream: child.stdout,
      type: StreamType.Arbitrary,
      process: child,
      source: 'yt-dlp',
      detachCancellation
    };
  }

  createAudioResource(playback: PreparedRadioPlayback, track: Pick<RadioTrack, 'title'>) {
    try {
      return createAudioResource(playback.stream, {
        inputType: playback.type,
        metadata: { title: track.title, source: playback.source }
      });
    } catch (error) {
      throw new RadioError(
        'AUDIO_PIPELINE_UNAVAILABLE',
        'Discord audio resource construction failed.',
        { cause: error }
      );
    }
  }

  disposePlayback(playback: PreparedRadioPlayback | null): void {
    if (!playback) return;
    playback.detachCancellation();
    this.disposeProcess(playback.process, playback.stream);
  }

  private disposeProcess(
    child: Pick<ChildProcessWithoutNullStreams, 'kill'> | null,
    stream: Readable | null
  ): void {
    try {
      child?.kill('SIGKILL');
    } catch {
      // The process already exited.
    }
    if (stream && !stream.destroyed) {
      try {
        stream.destroy();
      } catch {
        // The stream already closed.
      }
    }
  }
}
