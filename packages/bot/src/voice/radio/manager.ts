import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection
} from '@discordjs/voice';
import { logger } from '@silo/core';
import {
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type VoiceChannel,
  type VoiceState
} from 'discord.js';
import {
  guildVoiceCoordinator,
  type GuildVoiceCoordinator,
  type GuildVoiceLeaseToken
} from '../guild-voice-coordinator';
import { withLangfuseSpan } from '../../telemetry/langfuse-client';
import {
  MAX_RADIO_QUEUE_TRACKS,
  RADIO_QUEUE_CAPACITY_MESSAGE,
  RadioSourceResolver
} from './source';
import {
  RadioError,
  type PendingRadioAppend,
  type PreparedRadioPlayback,
  type RadioQueue,
  type RadioSourceResolution,
  type RadioTrack
} from './types';
import {
  STALE_RADIO_CONTROLS_MESSAGE,
  createPersistentRadioPayload,
  createQueueAcknowledgement,
  createQueueOverview,
  createRadioSessionChangedPayload,
  createRadioStoppedPayload
} from './ui';

const VOICE_READY_TIMEOUT_MS = 15_000;
const PLAYER_START_TIMEOUT_MS = 15_000;
const VOICE_RECONNECT_GRACE_MS = 5_000;
const QUEUE_ACK_TTL_MS = 12_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const EMPTY_VOICE_CHANNEL_MESSAGE =
  '❌ I only join voice channels that currently have at least one non-bot user in them.';
const AUDIO_PIPELINE_FAILURE_MESSAGE =
  '❌ The radio playback pipeline is unavailable. Restart Silo with its pinned runtime and run `bun run radio:validate`.';
const VOICE_CONNECTION_FAILURE_MESSAGE =
  '❌ I could not connect to that Discord voice channel. Confirm I have View Channel, Connect, and Speak permissions, then try again.';
const PLAYER_START_FAILURE_MESSAGE =
  '❌ I connected to voice, but radio playback did not start. Please try the command again.';

type StateTarget = AudioPlayer | VoiceConnection;
type StateWaiter = (target: StateTarget, status: string, timeoutMs: number) => Promise<unknown>;

export interface RadioRuntimeDependencies {
  createPlayer: typeof createAudioPlayer;
  joinVoice: typeof joinVoiceChannel;
  waitForState: StateWaiter;
}

interface PendingStartup {
  controller: AbortController;
  token: GuildVoiceLeaseToken | null;
  completion?: Promise<RadioQueue>;
}

interface RegisteredAppend {
  transaction: PendingRadioAppend;
  acknowledgement: string;
}

const defaultRuntime: RadioRuntimeDependencies = {
  createPlayer: createAudioPlayer,
  joinVoice: joinVoiceChannel,
  waitForState: (target, status, timeoutMs) =>
    entersState(target as never, status as never, timeoutMs)
};

const noMentions = { parse: [] as never[] };

const hasHumanListeners = (channel: VoiceChannel): boolean =>
  channel.members.some(member => !member.user.bot);

const failureMessage = (error: unknown, fallback: string): string => {
  if (!(error instanceof RadioError)) return fallback;
  switch (error.code) {
    case 'MUSIC_QUEUE_CAPACITY':
      return RADIO_QUEUE_CAPACITY_MESSAGE;
    case 'EMPTY_VOICE_CHANNEL':
      return EMPTY_VOICE_CHANNEL_MESSAGE;
    case 'AUDIO_PIPELINE_UNAVAILABLE':
      return AUDIO_PIPELINE_FAILURE_MESSAGE;
    case 'VOICE_CONNECTION_FAILED':
    case 'VOICE_CONNECTION_READY_TIMEOUT':
      return VOICE_CONNECTION_FAILURE_MESSAGE;
    case 'PLAYER_START_FAILED':
    case 'PLAYER_START_TIMEOUT':
      return PLAYER_START_FAILURE_MESSAGE;
    default:
      return error.message || fallback;
  }
};

const stableFailureCode = (error: unknown): string => {
  if (error instanceof RadioError) return error.code;
  return error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.name)
    ? error.name
    : 'RADIO_OPERATION_FAILED';
};

export class RadioManager {
  private readonly queues = new Map<string, RadioQueue>();
  private readonly mutationLanes = new Map<string, Promise<unknown>>();
  private readonly pendingStartups = new Map<string, PendingStartup>();
  private readonly pendingSourceResolutions = new Set<AbortController>();
  private readonly source: RadioSourceResolver;
  private readonly coordinator: GuildVoiceCoordinator;
  private readonly runtime: RadioRuntimeDependencies;
  private shutdownRequested = false;

  constructor({
    source = new RadioSourceResolver(),
    coordinator = guildVoiceCoordinator,
    runtime = defaultRuntime
  }: {
    source?: RadioSourceResolver;
    coordinator?: GuildVoiceCoordinator;
    runtime?: RadioRuntimeDependencies;
  } = {}) {
    this.source = source;
    this.coordinator = coordinator;
    this.runtime = runtime;
  }

  getQueue(guildId: string): RadioQueue | null {
    return this.queues.get(guildId) ?? null;
  }

  hasActiveQueue(guildId: string): boolean {
    return this.queues.has(guildId) || this.pendingStartups.has(guildId);
  }

  getConflictMessage(guildId: string): string | null {
    const activity = this.coordinator.getActiveActivity(guildId);
    if (!activity || activity.type === 'radio') return null;
    return `❌ Cannot start radio because voice chat is already active in <#${activity.channelId}>. Use \`/stopspeaking\` before starting radio.`;
  }

  async play(
    interaction: ChatInputCommandInteraction,
    link: string,
    channel: VoiceChannel
  ): Promise<void> {
    if (this.shutdownRequested) {
      await interaction.reply({
        content: 'Radio is shutting down.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions
      });
      return;
    }
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'Radio can only be used in a server.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions
      });
      return;
    }

    const sourceKind = this.source.classify(link);
    if (sourceKind === 'invalid') {
      await interaction.reply({
        content: 'Please provide a valid YouTube or Spotify track URL.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions
      });
      return;
    }
    const conflict = this.getConflictMessage(guildId);
    if (conflict) {
      await interaction.reply({
        content: conflict,
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions
      });
      return;
    }

    await interaction.deferReply({ fetchReply: false });
    try {
      if (sourceKind === 'spotify-track') {
        await interaction.editReply({
          content: '🎵 Processing Spotify link and finding a YouTube equivalent...',
          allowedMentions: noMentions
        });
      } else if (sourceKind === 'spotify-collection') {
        await interaction.editReply({
          content:
            '❌ Spotify albums and playlists are not supported yet. Use an individual Spotify track or a YouTube playlist instead.',
          allowedMentions: noMentions
        });
        return;
      } else {
        const analysis = this.source.classify(link);
        if (analysis === 'youtube' && /[?&]list=|\/playlist/i.test(link)) {
          await interaction.editReply({
            content: '📺 Fetching YouTube playlist information...',
            allowedMentions: noMentions
          });
        }
      }

      const resolutionController = new AbortController();
      this.pendingSourceResolutions.add(resolutionController);
      let resolution: RadioSourceResolution;
      try {
        resolution = await this.source.resolve(link, resolutionController.signal);
      } finally {
        this.pendingSourceResolutions.delete(resolutionController);
      }
      if (this.shutdownRequested || resolutionController.signal.aborted) {
        throw new RadioError('PLAYBACK_CANCELLED', 'Radio is shutting down.');
      }
      if (resolution.tracks.length > MAX_RADIO_QUEUE_TRACKS) {
        throw new RadioError('MUSIC_QUEUE_CAPACITY', RADIO_QUEUE_CAPACITY_MESSAGE);
      }

      let existing = this.queues.get(guildId);
      if (existing?.isFinished) {
        await this.stopQueue(guildId, 'finished_queue_replaced', existing);
        existing = undefined;
      }

      if (existing) {
        await this.appendToQueue(interaction, existing, resolution);
        return;
      }

      const queue = await this.startNewSession(
        guildId,
        channel,
        resolution.tracks[0] as RadioTrack,
        resolution.tracks.slice(1)
      );
      await this.sendInitialPlayer(interaction, queue);
    } catch (error) {
      if (this.shutdownRequested) return;
      logger.error('[RadioManager] Radio command failed', { code: stableFailureCode(error) });
      await interaction.editReply({
        content: failureMessage(error, 'Failed to play audio. Please check the URL and try again.'),
        embeds: [],
        components: [],
        allowedMentions: noMentions
      });
    }
  }

  private serialize<T>(guildId: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationLanes.get(guildId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(task);
    this.mutationLanes.set(guildId, operation);
    return operation.finally(() => {
      if (this.mutationLanes.get(guildId) === operation) {
        this.mutationLanes.delete(guildId);
      }
    });
  }

  private cancelPendingStartup(guildId: string): boolean {
    const pending = this.pendingStartups.get(guildId);
    if (!pending) return false;
    this.pendingStartups.delete(guildId);
    pending.controller.abort();
    if (pending.token) this.coordinator.release(guildId, pending.token);
    return true;
  }

  private startNewSession(
    guildId: string,
    channel: VoiceChannel,
    firstTrack: RadioTrack,
    remainingTracks: RadioTrack[]
  ): Promise<RadioQueue> {
    if (1 + remainingTracks.length > MAX_RADIO_QUEUE_TRACKS) {
      throw new RadioError('MUSIC_QUEUE_CAPACITY', RADIO_QUEUE_CAPACITY_MESSAGE);
    }
    if (!hasHumanListeners(channel)) {
      throw new RadioError('EMPTY_VOICE_CHANNEL', EMPTY_VOICE_CHANNEL_MESSAGE);
    }
    this.cancelPendingStartup(guildId);
    const pending: PendingStartup = {
      controller: new AbortController(),
      token: null
    };
    this.pendingStartups.set(guildId, pending);
    const completion = this.runNewSession(guildId, channel, firstTrack, remainingTracks, pending);
    pending.completion = completion;
    return completion;
  }

  private async runNewSession(
    guildId: string,
    channel: VoiceChannel,
    firstTrack: RadioTrack,
    remainingTracks: RadioTrack[],
    pending: PendingStartup
  ): Promise<RadioQueue> {
    return withLangfuseSpan(
      {
        name: 'radio.start-session',
        input: { source: firstTrack.isSpotifyTrack ? 'spotify-track' : 'youtube' },
        metadata: { queuedTracks: 1 + remainingTracks.length }
      },
      async observation => {
        let prepared: PreparedRadioPlayback | null = null;
        let player: AudioPlayer | null = null;
        let connection: VoiceConnection | null = null;
        let queue: RadioQueue | null = null;
        let phase = 'reservation';
        try {
          const reservation = this.coordinator.reserveExclusive(guildId, 'radio', channel.id);
          if (!reservation.acquired) {
            throw new RadioError(
              'VOICE_ACTIVITY_CONFLICT',
              `Another voice activity is already active in <#${reservation.channelId}>.`
            );
          }
          pending.token = reservation.token;

          phase = 'audio_stream';
          prepared = await this.source.preparePlayback(firstTrack.url, {
            signal: pending.controller.signal,
            isLive: firstTrack.isLive
          });
          phase = 'audio_resource';
          const resource = this.source.createAudioResource(prepared, firstTrack);
          this.assertStartupOwner(guildId, pending);
          if (!hasHumanListeners(channel)) {
            throw new RadioError('EMPTY_VOICE_CHANNEL', EMPTY_VOICE_CHANNEL_MESSAGE);
          }
          this.renewLease(guildId, reservation.token);

          phase = 'audio_player';
          try {
            player = this.runtime.createPlayer();
          } catch (error) {
            throw new RadioError(
              'AUDIO_PIPELINE_UNAVAILABLE',
              'Discord audio player construction failed.',
              { cause: error }
            );
          }

          phase = 'voice_join';
          try {
            connection = this.runtime.joinVoice({
              channelId: channel.id,
              guildId,
              adapterCreator: channel.guild
                .voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
              selfDeaf: false,
              selfMute: false
            });
          } catch (error) {
            throw new RadioError(
              'VOICE_CONNECTION_FAILED',
              'Discord voice connection creation failed.',
              { cause: error }
            );
          }

          queue = {
            guildId,
            voiceChannel: channel,
            songs: [firstTrack],
            currentIndex: 0,
            player,
            connection,
            leaseToken: reservation.token,
            currentProcess: prepared.process,
            currentStream: prepared.stream,
            pendingPreparation: pending.controller,
            persistentMessage: null,
            pendingControlInteractionId: null,
            pendingControlMessageId: null,
            isPaused: false,
            isFinished: false,
            isAdvancing: false,
            stopRequested: false,
            repeatMode: 0,
            mutationGeneration: 0,
            adoptionGeneration: 0,
            consecutiveFailures: 0,
            pendingTrackIndex: null,
            advanceCompletion: null,
            reconnectTimer: null,
            pendingAppends: []
          };
          this.configurePlayer(queue);
          this.configureConnection(queue);
          resource.playStream.once('error', () => {
            void this.stopQueue(guildId, 'audio_stream_error', queue ?? undefined);
          });

          phase = 'voice_ready';
          await this.waitForState(
            connection,
            VoiceConnectionStatus.Ready,
            VOICE_READY_TIMEOUT_MS,
            pending.controller.signal,
            'VOICE_CONNECTION_READY_TIMEOUT'
          );
          this.assertStartupOwner(guildId, pending);
          if (!hasHumanListeners(channel)) {
            throw new RadioError('EMPTY_VOICE_CHANNEL', EMPTY_VOICE_CHANNEL_MESSAGE);
          }
          this.renewLease(guildId, reservation.token);

          phase = 'player_subscription';
          if (!connection.subscribe(player)) {
            throw new RadioError('VOICE_CONNECTION_FAILED', 'Voice player subscription failed.');
          }
          phase = 'player_start';
          try {
            player.play(resource);
          } catch (error) {
            throw new RadioError('PLAYER_START_FAILED', 'Discord rejected the audio resource.', {
              cause: error
            });
          }
          await this.waitForState(
            player,
            AudioPlayerStatus.Playing,
            PLAYER_START_TIMEOUT_MS,
            pending.controller.signal,
            'PLAYER_START_TIMEOUT'
          );
          this.assertStartupOwner(guildId, pending);
          if (!hasHumanListeners(channel)) {
            throw new RadioError('EMPTY_VOICE_CHANNEL', EMPTY_VOICE_CHANNEL_MESSAGE);
          }
          if (!this.coordinator.commit(guildId, reservation.token, queue)) {
            throw new RadioError(
              'VOICE_ACTIVITY_CONFLICT',
              'The radio voice reservation expired before playback started.'
            );
          }

          prepared.detachCancellation();
          prepared = null;
          queue.pendingPreparation = null;
          queue.songs.push(...remainingTracks);
          this.queues.set(guildId, queue);
          observation?.update({ output: { status: 'ready', queuedTracks: queue.songs.length } });
          logger.info('[RadioManager] Radio session ready', { queuedTracks: queue.songs.length });
          return queue;
        } catch (error) {
          observation?.update({
            output: { status: 'failed', phase, code: stableFailureCode(error) },
            level: 'ERROR'
          });
          if (queue && this.queues.get(guildId) === queue) this.queues.delete(guildId);
          if (pending.token) this.coordinator.release(guildId, pending.token);
          this.source.disposePlayback(prepared);
          if (queue) this.disposeQueuePlayback(queue);
          try {
            player?.stop(true);
          } catch {
            // Player already stopped.
          }
          try {
            connection?.destroy();
          } catch {
            // Connection already destroyed.
          }
          logger.error('[RadioManager] Radio startup failed', {
            phase,
            code: stableFailureCode(error)
          });
          throw error;
        } finally {
          if (this.pendingStartups.get(guildId) === pending) {
            this.pendingStartups.delete(guildId);
          }
        }
      }
    );
  }

  private assertStartupOwner(guildId: string, pending: PendingStartup): void {
    if (pending.controller.signal.aborted || this.pendingStartups.get(guildId) !== pending) {
      throw new RadioError('PLAYBACK_CANCELLED', 'Radio startup was superseded.');
    }
  }

  private renewLease(guildId: string, token: GuildVoiceLeaseToken): void {
    if (!this.coordinator.renew(guildId, token)) {
      throw new RadioError(
        'VOICE_ACTIVITY_CONFLICT',
        'Another voice activity claimed this server during radio startup.'
      );
    }
  }

  private async waitForState(
    target: StateTarget,
    status: string,
    timeoutMs: number,
    signal: AbortSignal,
    timeoutCode: 'VOICE_CONNECTION_READY_TIMEOUT' | 'PLAYER_START_TIMEOUT'
  ): Promise<void> {
    if (signal.aborted) {
      throw new RadioError('PLAYBACK_CANCELLED', 'Radio startup was cancelled.');
    }
    let abortListener: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () =>
        reject(new RadioError('PLAYBACK_CANCELLED', 'Radio startup was cancelled.'));
      signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      await Promise.race([
        this.runtime.waitForState(target, status, timeoutMs).catch(error => {
          throw new RadioError(timeoutCode, 'Discord voice state transition failed.', {
            cause: error
          });
        }),
        aborted
      ]);
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  private configurePlayer(queue: RadioQueue): void {
    queue.player.on(AudioPlayerStatus.Idle, () => {
      if (this.queues.get(queue.guildId) !== queue) return;
      void this.handleTrackEnd(queue).catch(error => {
        logger.error('[RadioManager] Track completion failed', {
          code: stableFailureCode(error)
        });
        void this.stopQueue(queue.guildId, 'track_end_failure', queue);
      });
    });
    queue.player.on('error', () => {
      logger.error('[RadioManager] Audio player failed');
      void this.stopQueue(queue.guildId, 'player_error', queue);
    });
  }

  private configureConnection(queue: RadioQueue): void {
    const close = (reason: string) => {
      if (this.queues.get(queue.guildId) === queue) {
        void this.stopQueue(queue.guildId, reason, queue);
      } else {
        queue.pendingPreparation?.abort();
      }
    };
    queue.connection.on('error', () => {
      this.clearReconnectTimer(queue);
      close('voice_connection_error');
    });
    queue.connection.on('stateChange', (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Destroyed) {
        this.clearReconnectTimer(queue);
        close('voice_connection_destroyed');
      } else if (newState.status === VoiceConnectionStatus.Disconnected) {
        this.clearReconnectTimer(queue);
        queue.reconnectTimer = setTimeout(() => {
          queue.reconnectTimer = null;
          close('voice_reconnect_timeout');
        }, VOICE_RECONNECT_GRACE_MS);
        queue.reconnectTimer.unref?.();
      } else if (newState.status === VoiceConnectionStatus.Ready) {
        this.clearReconnectTimer(queue);
      }
    });
  }

  private clearReconnectTimer(queue: RadioQueue): void {
    if (!queue.reconnectTimer) return;
    clearTimeout(queue.reconnectTimer);
    queue.reconnectTimer = null;
  }

  private disposeQueuePlayback(queue: RadioQueue): void {
    queue.pendingPreparation?.abort();
    queue.pendingPreparation = null;
    const child = queue.currentProcess;
    const stream = queue.currentStream;
    queue.currentProcess = null;
    queue.currentStream = null;
    try {
      child?.kill('SIGKILL');
    } catch {
      // Process already stopped.
    }
    if (stream && !stream.destroyed) {
      try {
        stream.destroy();
      } catch {
        // Stream already closed.
      }
    }
  }

  private async sendInitialPlayer(
    interaction: ChatInputCommandInteraction,
    queue: RadioQueue
  ): Promise<boolean> {
    const snapshot = await this.serialize(queue.guildId, () => {
      if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) return null;
      const payload = createPersistentRadioPayload(queue);
      return payload ? { generation: queue.mutationGeneration, payload } : null;
    });
    if (!snapshot) return false;

    queue.pendingControlInteractionId = interaction.id;
    try {
      const message = (await interaction.editReply(snapshot.payload)) as Message;
      queue.pendingControlMessageId = message.id;
      return await this.attachPersistentMessage(queue, message, snapshot.generation);
    } catch (error) {
      if (queue.adoptionGeneration === 0) {
        await this.stopQueue(queue.guildId, 'initial_reply_failed', queue);
      }
      throw error;
    } finally {
      queue.pendingControlInteractionId = null;
      queue.pendingControlMessageId = null;
    }
  }

  private async attachPersistentMessage(
    queue: RadioQueue,
    message: Message,
    expectedGeneration: number
  ): Promise<boolean> {
    let generation = expectedGeneration;
    while (true) {
      const action = await this.serialize(queue.guildId, () => {
        if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) {
          return { type: 'stale' as const };
        }
        if (queue.mutationGeneration !== generation) {
          return {
            type: 'reconcile' as const,
            generation: queue.mutationGeneration,
            payload: createPersistentRadioPayload(queue)
          };
        }
        queue.persistentMessage = message;
        return { type: 'attached' as const };
      });

      if (action.type === 'attached') return true;
      if (action.type === 'stale' || !action.payload) {
        await this.removeControls(message);
        return false;
      }
      await message.edit(action.payload);
      generation = action.generation;
    }
  }

  private async removeControls(message: Message | null): Promise<void> {
    if (!message) return;
    try {
      await message.edit({ components: [], allowedMentions: noMentions });
    } catch {
      logger.warn('[RadioManager] Failed to remove stale player controls');
    }
  }

  private async refreshPersistentMessage(queue: RadioQueue, attempt = 0): Promise<boolean> {
    const message = queue.persistentMessage;
    if (!message || this.queues.get(queue.guildId) !== queue || queue.stopRequested) return false;
    const generation = queue.mutationGeneration;
    const payload = createPersistentRadioPayload(queue);
    if (!payload) return false;
    try {
      await message.edit(payload);
    } catch {
      logger.warn('[RadioManager] Failed to refresh the persistent player');
      return false;
    }
    if (
      this.queues.get(queue.guildId) !== queue ||
      queue.stopRequested ||
      queue.persistentMessage !== message
    ) {
      await this.removeControls(message);
      return false;
    }
    if (queue.mutationGeneration !== generation && attempt < 1) {
      return this.refreshPersistentMessage(queue, attempt + 1);
    }
    return true;
  }

  private async registerAppend(
    queue: RadioQueue,
    tracks: RadioTrack[],
    label: string
  ): Promise<RegisteredAppend> {
    return this.serialize(queue.guildId, () => {
      if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) {
        throw new Error('Radio queue ownership changed.');
      }
      const pendingTracks = queue.pendingAppends.flatMap(item => item.tracks);
      if (queue.songs.length + pendingTracks.length + tracks.length > MAX_RADIO_QUEUE_TRACKS) {
        throw new RadioError('MUSIC_QUEUE_CAPACITY', RADIO_QUEUE_CAPACITY_MESSAGE);
      }
      const startPosition = queue.songs.length + pendingTracks.length + 1;
      let resolveCompletion: PendingRadioAppend['resolveCompletion'] = null;
      const transaction: PendingRadioAppend = {
        tracks,
        outcome: 'pending',
        completion: new Promise(resolve => {
          resolveCompletion = resolve;
        }),
        resolveCompletion: null
      };
      transaction.resolveCompletion = resolveCompletion;
      queue.pendingAppends.push(transaction);
      const projected = {
        ...queue,
        songs: [...queue.songs, ...pendingTracks, ...tracks]
      } as RadioQueue;
      return {
        transaction,
        acknowledgement: createQueueAcknowledgement(label, projected, startPosition, tracks.length)
      };
    });
  }

  private resolveAppend(
    transaction: PendingRadioAppend,
    outcome: 'committed' | 'failed' | 'stale'
  ): void {
    transaction.resolveCompletion?.(outcome);
    transaction.resolveCompletion = null;
  }

  private resolvePendingAppends(queue: RadioQueue, outcome: 'failed' | 'stale'): void {
    for (const transaction of queue.pendingAppends.splice(0)) {
      this.resolveAppend(transaction, outcome);
    }
  }

  private async settleAppend(
    queue: RadioQueue,
    transaction: PendingRadioAppend,
    outcome: 'succeeded' | 'failed'
  ): Promise<{ committed: boolean; shouldResume: boolean }> {
    return this.serialize(queue.guildId, () => {
      if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) {
        this.resolvePendingAppends(queue, 'stale');
        this.resolveAppend(transaction, 'stale');
        return { committed: false, shouldResume: false };
      }
      if (!queue.pendingAppends.includes(transaction)) {
        this.resolveAppend(transaction, 'stale');
        return { committed: false, shouldResume: false };
      }

      transaction.outcome = outcome;
      let committed = false;
      while (queue.pendingAppends[0]?.outcome !== 'pending' && queue.pendingAppends.length > 0) {
        const next = queue.pendingAppends.shift();
        if (!next) break;
        if (next.outcome === 'failed') {
          this.resolveAppend(next, 'failed');
          continue;
        }
        queue.songs.push(...next.tracks);
        queue.mutationGeneration += 1;
        queue.adoptionGeneration += 1;
        committed = true;
        this.resolveAppend(next, 'committed');
      }

      const shouldResume = committed && queue.isFinished;
      if (shouldResume) queue.isFinished = false;
      return { committed, shouldResume };
    });
  }

  private async appendToQueue(
    interaction: ChatInputCommandInteraction,
    queue: RadioQueue,
    resolution: RadioSourceResolution
  ): Promise<void> {
    const label =
      resolution.kind === 'youtube-playlist'
        ? 'YouTube playlist queued'
        : resolution.kind === 'spotify-track'
          ? 'Spotify track queued'
          : 'Song queued';
    const { transaction, acknowledgement } = await this.registerAppend(
      queue,
      resolution.tracks,
      label
    );

    let acknowledgementFailed = false;
    try {
      await interaction.editReply({
        content: acknowledgement,
        embeds: [],
        components: [],
        allowedMentions: noMentions
      });
    } catch {
      acknowledgementFailed = true;
    }

    const settlement = await this.settleAppend(
      queue,
      transaction,
      acknowledgementFailed ? 'failed' : 'succeeded'
    );
    const result = await transaction.completion;
    if (settlement.shouldResume) {
      await this.playTrackAt(queue, queue.currentIndex + 1);
    } else if (settlement.committed) {
      await this.refreshPersistentMessage(queue);
    }
    if (result === 'stale') throw new Error('Radio queue ownership changed.');
    if (acknowledgementFailed && result === 'failed') {
      throw new Error('Discord did not accept the queue acknowledgement.');
    }

    const timer = setTimeout(() => {
      void interaction.deleteReply().catch(() => undefined);
    }, QUEUE_ACK_TTL_MS);
    timer.unref?.();
  }

  private async handleTrackEnd(queue: RadioQueue): Promise<void> {
    if (queue.isAdvancing) return;
    queue.isAdvancing = true;
    let resolveAdvance!: () => void;
    const completion = new Promise<void>(resolve => {
      resolveAdvance = resolve;
    });
    queue.advanceCompletion = completion;
    try {
      const action = await this.serialize(queue.guildId, () => {
        if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) return null;
        if (!this.ensureHumanListeners(queue)) return null;
        queue.mutationGeneration += 1;

        const pendingIndex = queue.pendingTrackIndex;
        queue.pendingTrackIndex = null;
        if (pendingIndex !== null && pendingIndex >= 0 && pendingIndex < queue.songs.length) {
          return { type: 'advance' as const, index: pendingIndex };
        }
        if (queue.repeatMode === 1) {
          return { type: 'advance' as const, index: queue.currentIndex };
        }
        if (queue.currentIndex >= queue.songs.length - 1) {
          if (queue.repeatMode === 2) return { type: 'advance' as const, index: 0 };
          queue.isFinished = true;
          return { type: 'finish' as const };
        }
        return { type: 'advance' as const, index: queue.currentIndex + 1 };
      });
      if (action?.type === 'advance') {
        await this.playTrackAt(queue, action.index);
      } else if (action?.type === 'finish') {
        await this.refreshPersistentMessage(queue);
      }
    } finally {
      queue.isAdvancing = false;
      if (queue.advanceCompletion === completion) queue.advanceCompletion = null;
      resolveAdvance();
    }
  }

  private async playTrackAt(queue: RadioQueue, index: number): Promise<void> {
    if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) return;
    if (!this.ensureHumanListeners(queue)) return;
    if (index < 0 || index >= queue.songs.length) {
      queue.isFinished = true;
      await this.refreshPersistentMessage(queue);
      return;
    }

    queue.currentIndex = index;
    queue.isFinished = false;
    const track = queue.songs[index];
    if (!track) return;
    this.disposeQueuePlayback(queue);
    const controller = new AbortController();
    queue.pendingPreparation = controller;
    let prepared: PreparedRadioPlayback | null = null;
    try {
      prepared = await this.source.preparePlayback(track.url, {
        signal: controller.signal,
        isLive: track.isLive
      });
      if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) {
        throw new RadioError('PLAYBACK_CANCELLED', 'Radio queue ownership changed.');
      }
      const resource = this.source.createAudioResource(prepared, track);
      if (this.queues.get(queue.guildId) !== queue || queue.stopRequested) {
        throw new RadioError('PLAYBACK_CANCELLED', 'Radio queue ownership changed.');
      }
      const detachCancellation = prepared.detachCancellation;
      queue.currentProcess = prepared.process;
      queue.currentStream = prepared.stream;
      prepared = null;
      queue.player.play(resource);
      await this.waitForState(
        queue.player,
        AudioPlayerStatus.Playing,
        PLAYER_START_TIMEOUT_MS,
        controller.signal,
        'PLAYER_START_TIMEOUT'
      );
      detachCancellation();
      queue.isPaused = false;
      queue.consecutiveFailures = 0;
      await this.refreshPersistentMessage(queue);
    } catch (error) {
      this.source.disposePlayback(prepared);
      if (!prepared) this.disposeQueuePlayback(queue);
      if (this.queues.get(queue.guildId) !== queue) return;
      if (queue.stopRequested) {
        await this.stopQueue(queue.guildId, 'stop_during_preparation', queue);
        return;
      }
      queue.consecutiveFailures += 1;
      logger.warn('[RadioManager] Queued track failed', {
        consecutiveFailures: queue.consecutiveFailures,
        code: stableFailureCode(error)
      });
      if (queue.persistentMessage?.channel.isSendable()) {
        await queue.persistentMessage.channel
          .send({
            embeds: [
              new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('⚠️ Playback Error')
                .setDescription(`**${track.title}**\n\nFailed to play this track.`)
                .setTimestamp()
            ],
            allowedMentions: noMentions
          })
          .catch(() => undefined);
      }
      if (
        queue.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ||
        queue.currentIndex >= queue.songs.length - 1
      ) {
        await this.stopQueue(queue.guildId, 'consecutive_playback_failures', queue);
      } else {
        await this.playTrackAt(queue, queue.currentIndex + 1);
      }
    } finally {
      if (queue.pendingPreparation === controller) queue.pendingPreparation = null;
    }
  }

  private ensureHumanListeners(queue: RadioQueue): boolean {
    if (hasHumanListeners(queue.voiceChannel)) return true;
    void this.stopQueue(queue.guildId, 'no_human_listeners', queue);
    return false;
  }

  private ownsControls(interaction: ButtonInteraction, queue: RadioQueue): boolean {
    if (queue.persistentMessage?.id) return interaction.message.id === queue.persistentMessage.id;
    if (queue.pendingControlMessageId) {
      return interaction.message.id === queue.pendingControlMessageId;
    }
    const metadata = interaction.message.interactionMetadata;
    return Boolean(
      queue.pendingControlInteractionId && metadata?.id === queue.pendingControlInteractionId
    );
  }

  async handleButtonInteraction(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith('radio:')) return false;
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: 'Radio controls only work in a server.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions
      });
      return true;
    }
    const queue = this.queues.get(guildId);
    if (!queue) {
      await interaction.reply({
        content: 'No radio is currently playing!',
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions
      });
      return true;
    }
    if (!this.ownsControls(interaction, queue)) {
      await interaction.reply({
        content: STALE_RADIO_CONTROLS_MESSAGE,
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions
      });
      return true;
    }

    return withLangfuseSpan(
      {
        name: 'radio.control',
        input: { action: interaction.customId.slice('radio:'.length) },
        metadata: { queueLength: queue.songs.length }
      },
      async observation => {
        const action = interaction.customId.slice('radio:'.length);
        if (action === 'queue') {
          await interaction.reply(createQueueOverview(queue));
          observation?.update({ output: { status: 'shown' } });
          return true;
        }
        if (!queue.player) {
          await interaction.reply({
            content: 'No audio player is currently active!',
            flags: MessageFlags.Ephemeral,
            allowedMentions: noMentions
          });
          return true;
        }

        if (action === 'skip' && queue.currentIndex >= queue.songs.length - 1) {
          await interaction.reply({
            content: 'No more songs in the queue!',
            flags: MessageFlags.Ephemeral,
            allowedMentions: noMentions
          });
          return true;
        }
        if (action === 'previous' && queue.currentIndex <= 0) {
          await interaction.reply({
            content: 'No previous songs!',
            flags: MessageFlags.Ephemeral,
            allowedMentions: noMentions
          });
          return true;
        }

        await interaction.deferUpdate();
        if (queue.advanceCompletion) await queue.advanceCompletion;
        if (action === 'stop') {
          const stopped = await this.stopQueue(guildId, 'button', queue);
          await interaction.editReply(
            stopped ? createRadioStoppedPayload() : createRadioSessionChangedPayload()
          );
          observation?.update({ output: { status: stopped ? 'stopped' : 'stale' } });
          return true;
        }

        const payload = await this.serialize(guildId, () => {
          if (this.queues.get(guildId) !== queue || queue.stopRequested || queue.isFinished) {
            return null;
          }
          switch (action) {
            case 'pause': {
              queue.mutationGeneration += 1;
              if (queue.isPaused) {
                queue.player.unpause();
                queue.isPaused = false;
              } else {
                queue.player.pause();
                queue.isPaused = true;
              }
              return createPersistentRadioPayload(queue);
            }
            case 'skip':
              if (queue.currentIndex < queue.songs.length - 1) {
                queue.mutationGeneration += 1;
                queue.player.stop();
                return undefined;
              }
              return 'no-next' as const;
            case 'previous':
              if (queue.currentIndex > 0) {
                queue.mutationGeneration += 1;
                queue.pendingTrackIndex = queue.currentIndex - 1;
                queue.player.stop();
                return undefined;
              }
              return 'no-previous' as const;
            case 'repeat':
              queue.mutationGeneration += 1;
              queue.repeatMode = ((queue.repeatMode + 1) % 3) as RadioQueue['repeatMode'];
              return createPersistentRadioPayload(queue);
            default:
              return 'unknown' as const;
          }
        });

        if (payload === 'no-next') {
          await interaction.followUp({
            content: 'No more songs in the queue!',
            flags: MessageFlags.Ephemeral,
            allowedMentions: noMentions
          });
        } else if (payload === 'no-previous') {
          await interaction.followUp({
            content: 'No previous songs!',
            flags: MessageFlags.Ephemeral,
            allowedMentions: noMentions
          });
        } else if (payload === 'unknown') {
          await interaction.followUp({
            content: 'Unknown radio control.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: noMentions
          });
        } else if (payload) {
          await interaction.editReply(payload);
          if (this.queues.get(guildId) !== queue || queue.stopRequested) {
            await interaction.editReply({ components: [], allowedMentions: noMentions });
          }
        }
        observation?.update({ output: { status: 'completed', action } });
        return true;
      }
    );
  }

  handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): boolean {
    const guildId = newState.guild.id || oldState.guild.id;
    const queue = this.queues.get(guildId);
    if (!queue) return false;
    const channelId = queue.voiceChannel.id;
    if (oldState.channelId !== channelId && newState.channelId !== channelId) return true;
    return this.ensureHumanListeners(queue);
  }

  private async stopQueue(
    guildId: string,
    reason: string,
    expectedQueue?: RadioQueue
  ): Promise<boolean> {
    const queue = this.queues.get(guildId);
    if (expectedQueue && queue !== expectedQueue) return false;
    if (!queue) {
      this.cancelPendingStartup(guildId);
      return false;
    }
    queue.stopRequested = true;
    queue.pendingPreparation?.abort();
    return this.serialize(guildId, () => this.stopQueueNow(guildId, reason, expectedQueue));
  }

  private stopQueueNow(guildId: string, reason: string, expectedQueue?: RadioQueue): boolean {
    const queue = this.queues.get(guildId);
    if (!queue || (expectedQueue && queue !== expectedQueue)) return false;
    this.queues.delete(guildId);
    this.resolvePendingAppends(queue, 'stale');
    this.clearReconnectTimer(queue);
    const message = queue.persistentMessage;
    queue.persistentMessage = null;
    void this.removeControls(message);
    this.disposeQueuePlayback(queue);
    try {
      queue.player.stop(true);
    } catch {
      // Player already stopped.
    }
    try {
      queue.connection.destroy();
    } catch {
      // Connection already destroyed.
    }
    if (!this.coordinator.release(guildId, queue.leaseToken)) {
      this.coordinator.stop(guildId, 'radio', queue);
    }
    logger.info('[RadioManager] Radio queue stopped', { reason });
    return true;
  }

  async stopAll(reason = 'shutdown'): Promise<void> {
    this.shutdownRequested = true;
    for (const controller of this.pendingSourceResolutions) controller.abort();
    const pending = [...this.pendingStartups.entries()];
    for (const [guildId] of pending) this.cancelPendingStartup(guildId);
    const queues = [...this.queues.entries()];
    await Promise.allSettled([
      ...queues.map(([guildId, queue]) => this.stopQueue(guildId, reason, queue)),
      ...pending.flatMap(([, startup]) => (startup.completion ? [startup.completion] : []))
    ]);
  }
}

export const radioManager = new RadioManager();
