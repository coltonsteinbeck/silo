import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  DiscordGatewayAdapterCreator
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { performance } from 'node:perf_hooks';
import { logger } from '@silo/core';
import { RealtimeSession } from './realtime-session';
import { guildVoiceCoordinator, type GuildVoiceLeaseToken } from './guild-voice-coordinator';

interface ActiveSpeaker {
  session: RealtimeSession;
  stop: () => Promise<void>;
}

interface SessionInfo {
  connection: VoiceConnection;
  activeSpeakers: Map<string, ActiveSpeaker>;
  guildId: string;
  channelId: string;
  leaseToken: GuildVoiceLeaseToken;
}

export interface VoiceSessionRuntimeDependencies {
  joinVoice: typeof joinVoiceChannel;
  waitForState: (
    connection: VoiceConnection,
    status: VoiceConnectionStatus,
    timeoutMs: number
  ) => Promise<VoiceConnection>;
  createRealtimeSession?: (
    ...args: ConstructorParameters<typeof RealtimeSession>
  ) => RealtimeSession;
}

const defaultRuntime: VoiceSessionRuntimeDependencies = {
  joinVoice: joinVoiceChannel,
  waitForState: (connection, status, timeoutMs) => entersState(connection, status, timeoutMs)
};

/**
 * Manages voice connections and realtime sessions across guilds.
 * Supports simultaneous multi-speaker conversations in the same channel.
 */
export class VoiceSessionManager {
  private sessions: Map<string, SessionInfo> = new Map(); // guildId -> SessionInfo
  private shuttingDown = false;

  constructor(private readonly runtime: VoiceSessionRuntimeDependencies = defaultRuntime) {}

  /**
   * Check if a guild has an active voice session
   */
  hasSession(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  /**
   * Check if a user is actively speaking in a guild
   */
  isUserSpeaking(guildId: string, userId: string): boolean {
    const session = this.sessions.get(guildId);
    return session?.activeSpeakers.has(userId) ?? false;
  }

  /**
   * Get active speaker count for a guild
   */
  getActiveSpeakerCount(guildId: string): number {
    const session = this.sessions.get(guildId);
    return session?.activeSpeakers.size ?? 0;
  }

  /**
   * Join a voice channel and prepare for realtime sessions
   */
  async joinChannel(channel: VoiceBasedChannel): Promise<VoiceConnection> {
    if (this.shuttingDown) throw new Error('Voice is shutting down.');
    const guildId = channel.guild.id;

    // Check if already in this channel
    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channel.id) {
      return existing.connection;
    }

    if (existing) {
      throw new Error('A voice conversation is already active in another channel.');
    }

    const reservation = guildVoiceCoordinator.reserveExclusive(guildId, 'speech', channel.id);
    if (!reservation.acquired) {
      const activityName =
        reservation.conflictType === 'radio' ? 'radio playback' : 'another voice session';
      throw new Error(
        `Cannot start voice chat because ${activityName} is active in <#${reservation.channelId}>.`
      );
    }

    let connection: VoiceConnection;
    try {
      connection = this.runtime.joinVoice({
        channelId: channel.id,
        guildId: channel.guild.id,
        // Type cast needed due to discord.js/voice version mismatch
        adapterCreator: channel.guild
          .voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });
    } catch (error) {
      guildVoiceCoordinator.release(guildId, reservation.token);
      throw error;
    }

    logger.info(
      `[VoiceSessionManager] Attempting to join channel ${channel.id} (${channel.name}), current state: ${connection.state.status}`
    );

    // Log state changes for debugging
    connection.on('stateChange', (oldState: { status: string }, newState: { status: string }) => {
      logger.debug(
        `[VoiceSessionManager] Connection state change: ${oldState.status} -> ${newState.status}`
      );
    });

    connection.on('error', (error: Error) => {
      logger.error('[VoiceSessionManager] Connection error:', error);
    });

    // Wait for connection to be ready
    try {
      await this.runtime.waitForState(connection, VoiceConnectionStatus.Ready, 30_000);
      logger.info(
        `[VoiceSessionManager] Successfully connected to channel ${channel.id} (${channel.name})`
      );
    } catch (error) {
      logger.error(
        `[VoiceSessionManager] Connection timeout. Final state: ${connection.state.status}`,
        error
      );
      connection.destroy();
      guildVoiceCoordinator.release(guildId, reservation.token);
      throw new Error(
        `Failed to connect to voice channel within 30 seconds. Bot may need "Connect" and "Speak" permissions in ${channel.name}.`,
        { cause: error }
      );
    }

    if (this.shuttingDown) {
      guildVoiceCoordinator.release(guildId, reservation.token);
      connection.destroy();
      throw new Error('Voice is shutting down.');
    }

    // Handle disconnection
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          this.runtime.waitForState(connection, VoiceConnectionStatus.Signalling, 5_000),
          this.runtime.waitForState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
        // Connection is reconnecting
      } catch {
        // Connection is truly disconnected
        this.cleanup(guildId, connection);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.cleanup(guildId, connection);
    });

    const sessionInfo: SessionInfo = {
      connection,
      activeSpeakers: new Map(),
      guildId,
      channelId: channel.id,
      leaseToken: reservation.token
    };
    if (!guildVoiceCoordinator.commit(guildId, reservation.token, sessionInfo)) {
      connection.destroy();
      guildVoiceCoordinator.release(guildId, reservation.token);
      throw new Error('Voice session ownership changed before the connection became ready.');
    }
    this.sessions.set(guildId, sessionInfo);

    return connection;
  }

  /**
   * Start a realtime session for a specific user in a guild
   */
  async startSpeaking(
    guildId: string,
    userId: string,
    apiKey: string,
    options?: {
      voice?: string;
      instructions?: string;
      assistantSafetyPolicy?: 'standard' | 'contextual_banter';
      onAudioResponse?: (audio: Buffer) => void;
      maxDurationMs?: number;
      beforeConnect?: () => Promise<void>;
      authorizeConnection?: () => void;
      onEnd?: (durationMs: number) => void;
    }
  ): Promise<RealtimeSession> {
    if (this.shuttingDown) throw new Error('Voice is shutting down.');
    const sessionInfo = this.sessions.get(guildId);
    if (!sessionInfo) {
      throw new Error('No voice connection in this guild. Join a voice channel first.');
    }

    // Check if user already has an active session
    if (sessionInfo.activeSpeakers.has(userId)) {
      throw new Error('You already have an active speaking session.');
    }

    let startedAt: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let endRecorded = false;
    const recordEnd = () => {
      if (startedAt === undefined || endRecorded) return;
      endRecorded = true;
      try {
        options?.onEnd?.(performance.now() - startedAt);
      } catch (error) {
        logger.error('Could not persist measured voice quota', {
          errorType: error instanceof Error ? error.name : 'unknown'
        });
      }
    };
    const finish = () => {
      if (timer) clearTimeout(timer);
      recordEnd();
      if (sessionInfo.activeSpeakers.get(userId) === speaker) {
        sessionInfo.activeSpeakers.delete(userId);
        if (sessionInfo.activeSpeakers.size === 0 && this.sessions.get(guildId) === sessionInfo) {
          void this.leaveGuild(guildId).catch(() => {});
        }
      }
    };
    const createRealtimeSession =
      this.runtime.createRealtimeSession ?? ((...args) => new RealtimeSession(...args));
    const realtimeSession = createRealtimeSession(apiKey, userId, {
      guildId,
      voice: options?.voice || 'alloy',
      instructions: options?.instructions,
      assistantSafetyPolicy: options?.assistantSafetyPolicy,
      onAudioResponse:
        options?.onAudioResponse ||
        (_audio => {
          // Default: play through the connection
          this.playAudio(guildId, _audio);
        }),
      onError: (error: Error) => {
        logger.error(`[Voice] Realtime session error for user ${userId}:`, error);
        void speaker.stop().catch(() => {});
      },
      onClose: () => {
        finish();
      }
    });
    let stopping: Promise<void> | undefined;
    const speaker = {
      session: realtimeSession,
      stop: () => {
        recordEnd();
        return (stopping ??= Promise.resolve()
          .then(() => realtimeSession.disconnect())
          .then(() => undefined)
          .finally(finish));
      }
    };
    sessionInfo.activeSpeakers.set(userId, speaker);
    try {
      await options?.beforeConnect?.();
      startedAt = performance.now();
      if (stopping || this.sessions.get(guildId) !== sessionInfo) {
        throw new Error('Voice connection changed before speech started.');
      }
      options?.authorizeConnection?.();
      if (options?.maxDurationMs) {
        timer = setTimeout(() => void speaker.stop().catch(() => {}), options.maxDurationMs);
        timer.unref();
      }
      await realtimeSession.connect();
      if (stopping || sessionInfo.activeSpeakers.get(userId) !== speaker) {
        throw new Error('Voice connection stopped before speech started.');
      }
      return realtimeSession;
    } catch (error) {
      await speaker.stop().catch(() => {});
      finish();
      throw error;
    }
  }

  /**
   * Stop a user's speaking session
   */
  async stopSpeaking(guildId: string, userId: string): Promise<boolean> {
    const sessionInfo = this.sessions.get(guildId);
    if (!sessionInfo) return false;

    const speaker = sessionInfo.activeSpeakers.get(userId);
    if (!speaker) return false;
    await speaker.stop();
    return true;
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const { activeSpeakers } of this.sessions.values()) {
      for (const speaker of activeSpeakers.values()) {
        void speaker.stop().catch(() => {});
      }
    }
  }

  /**
   * Send audio data to a user's realtime session
   */
  sendAudio(guildId: string, userId: string, audio: Buffer): void {
    const sessionInfo = this.sessions.get(guildId);
    sessionInfo?.activeSpeakers.get(userId)?.session.sendAudio(audio);
  }

  /**
   * Play audio through the voice connection
   */
  private playAudio(_guildId: string, _audio: Buffer): void {
    // Audio playback is handled by the realtime session's audio player
    // This is a placeholder for custom audio routing if needed
  }

  /**
   * Leave a guild's voice channel and cleanup all sessions
   */
  async leaveGuild(guildId: string): Promise<void> {
    const sessionInfo = this.sessions.get(guildId);
    if (!sessionInfo) return;

    this.sessions.delete(guildId);
    // Stop all active speakers while the guild voice lease still protects the connection.
    for (const [userId, speaker] of sessionInfo.activeSpeakers) {
      try {
        await speaker.stop();
      } catch (error) {
        logger.error(`[Voice] Error stopping session for user ${userId}:`, error);
      }
    }

    // Remove ownership before destroying because Destroyed can emit
    // synchronously and re-enter cleanup.
    if (!guildVoiceCoordinator.release(guildId, sessionInfo.leaseToken)) {
      guildVoiceCoordinator.stop(guildId, 'speech', sessionInfo);
    }
    sessionInfo.connection.destroy();
  }

  /**
   * Cleanup a guild's session (internal)
   */
  private cleanup(guildId: string, connection: VoiceConnection): void {
    const sessionInfo = this.sessions.get(guildId);
    if (!sessionInfo || sessionInfo.connection !== connection) return;

    // Stop all active speakers
    for (const speaker of sessionInfo.activeSpeakers.values()) {
      void speaker.stop().catch(() => {});
    }

    this.sessions.delete(guildId);
    if (!guildVoiceCoordinator.release(guildId, sessionInfo.leaseToken)) {
      guildVoiceCoordinator.stop(guildId, 'speech', sessionInfo);
    }
  }

  /**
   * Get the voice connection for a guild
   */
  getConnection(guildId: string): VoiceConnection | undefined {
    return this.sessions.get(guildId)?.connection;
  }

  /**
   * Get all active guild IDs
   */
  getActiveGuildIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}

// Singleton instance
export const voiceSessionManager = new VoiceSessionManager();
