import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { AudioPlayer, StreamType, VoiceConnection } from '@discordjs/voice';
import type { Message, VoiceChannel } from 'discord.js';
import type { GuildVoiceLeaseToken } from '../guild-voice-coordinator';

export interface RadioTrack {
  url: string;
  title: string;
  channel: string;
  duration: string;
  thumbnail: string | null;
  isSpotifyTrack: boolean;
  originalSpotifyUrl?: string;
  isLive?: boolean;
}

export interface PreparedRadioPlayback {
  stream: Readable;
  type: StreamType;
  process: ChildProcessWithoutNullStreams;
  source: 'yt-dlp';
  detachCancellation: () => void;
}

export interface RadioQueue {
  guildId: string;
  voiceChannel: VoiceChannel;
  songs: RadioTrack[];
  currentIndex: number;
  player: AudioPlayer;
  connection: VoiceConnection;
  leaseToken: GuildVoiceLeaseToken;
  currentProcess: ChildProcessWithoutNullStreams | null;
  currentStream: Readable | null;
  pendingPreparation: AbortController | null;
  persistentMessage: Message | null;
  pendingControlInteractionId: string | null;
  pendingControlMessageId: string | null;
  isPaused: boolean;
  isFinished: boolean;
  isAdvancing: boolean;
  stopRequested: boolean;
  repeatMode: 0 | 1 | 2;
  mutationGeneration: number;
  adoptionGeneration: number;
  consecutiveFailures: number;
  pendingTrackIndex: number | null;
  advanceCompletion: Promise<void> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pendingAppends: PendingRadioAppend[];
}

export interface PendingRadioAppend {
  tracks: RadioTrack[];
  outcome: 'pending' | 'succeeded' | 'failed';
  completion: Promise<'committed' | 'failed' | 'stale'>;
  resolveCompletion: ((result: 'committed' | 'failed' | 'stale') => void) | null;
}

export interface RadioSourceResolution {
  kind: 'youtube-video' | 'youtube-playlist' | 'spotify-track';
  displayName: string;
  tracks: RadioTrack[];
}

export type RadioFailureCode =
  | 'AUDIO_PIPELINE_UNAVAILABLE'
  | 'EMPTY_VOICE_CHANNEL'
  | 'INVALID_MEDIA_URL'
  | 'MUSIC_QUEUE_CAPACITY'
  | 'PLAYBACK_CANCELLED'
  | 'PLAYER_START_FAILED'
  | 'PLAYER_START_TIMEOUT'
  | 'SPOTIFY_COLLECTION_UNSUPPORTED'
  | 'VOICE_ACTIVITY_CONFLICT'
  | 'VOICE_CONNECTION_FAILED'
  | 'VOICE_CONNECTION_READY_TIMEOUT';

export class RadioError extends Error {
  constructor(
    public readonly code: RadioFailureCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RadioError';
  }
}
