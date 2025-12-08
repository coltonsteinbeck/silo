import {
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  DiscordGatewayAdapterCreator
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { RealtimeSession } from './realtime-session';

interface SessionInfo {
  connection: VoiceConnection;
  activeSpeakers: Map<string, RealtimeSession>; // userId -> session (simultaneous multi-speaker)
  guildId: string;
  channelId: string;
  createdAt: Date;
}

/**
 * Manages voice connections and realtime sessions across guilds.
 * Supports simultaneous multi-speaker conversations in the same channel.
 */
export class VoiceSessionManager {
  private sessions: Map<string, SessionInfo> = new Map(); // guildId -> SessionInfo

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
    const guildId = channel.guild.id;
    
    // Check if already in this channel
    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channel.id) {
      return existing.connection;
    }

    // Leave existing channel if in a different one
    if (existing) {
      await this.leaveGuild(guildId);
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      // Type cast needed due to discord.js/voice version mismatch
      adapterCreator: channel.guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    // Wait for connection to be ready
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch {
      connection.destroy();
      throw new Error('Failed to connect to voice channel within 30 seconds');
    }

    // Handle disconnection
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
        // Connection is reconnecting
      } catch {
        // Connection is truly disconnected
        this.cleanup(guildId);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.cleanup(guildId);
    });

    this.sessions.set(guildId, {
      connection,
      activeSpeakers: new Map(),
      guildId,
      channelId: channel.id,
      createdAt: new Date()
    });

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
      onAudioResponse?: (audio: Buffer) => void;
    }
  ): Promise<RealtimeSession> {
    const sessionInfo = this.sessions.get(guildId);
    if (!sessionInfo) {
      throw new Error('No voice connection in this guild. Join a voice channel first.');
    }

    // Check if user already has an active session
    if (sessionInfo.activeSpeakers.has(userId)) {
      throw new Error('You already have an active speaking session.');
    }

    // Create realtime session for this user
    const realtimeSession = new RealtimeSession(apiKey, userId, {
      voice: options?.voice || 'alloy',
      instructions: options?.instructions,
      onAudioResponse: options?.onAudioResponse || ((_audio) => {
        // Default: play through the connection
        this.playAudio(guildId, _audio);
      }),
      onError: (error: Error) => {
        console.error(`[Voice] Realtime session error for user ${userId}:`, error);
        this.stopSpeaking(guildId, userId);
      },
      onClose: () => {
        sessionInfo.activeSpeakers.delete(userId);
      }
    });

    await realtimeSession.connect();
    sessionInfo.activeSpeakers.set(userId, realtimeSession);

    return realtimeSession;
  }

  /**
   * Stop a user's speaking session
   */
  async stopSpeaking(guildId: string, userId: string): Promise<boolean> {
    const sessionInfo = this.sessions.get(guildId);
    if (!sessionInfo) return false;

    const realtimeSession = sessionInfo.activeSpeakers.get(userId);
    if (!realtimeSession) return false;

    await realtimeSession.disconnect();
    sessionInfo.activeSpeakers.delete(userId);
    return true;
  }

  /**
   * Send audio data to a user's realtime session
   */
  sendAudio(guildId: string, userId: string, audio: Buffer): void {
    const sessionInfo = this.sessions.get(guildId);
    const realtimeSession = sessionInfo?.activeSpeakers.get(userId);
    realtimeSession?.sendAudio(audio);
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

    // Stop all active speakers
    for (const [userId, realtimeSession] of sessionInfo.activeSpeakers) {
      try {
        await realtimeSession.disconnect();
      } catch (error) {
        console.error(`[Voice] Error stopping session for user ${userId}:`, error);
      }
    }

    // Destroy the connection
    sessionInfo.connection.destroy();
    this.sessions.delete(guildId);
  }

  /**
   * Cleanup a guild's session (internal)
   */
  private cleanup(guildId: string): void {
    const sessionInfo = this.sessions.get(guildId);
    if (!sessionInfo) return;

    // Stop all active speakers
    for (const realtimeSession of sessionInfo.activeSpeakers.values()) {
      realtimeSession.disconnect().catch(() => {});
    }

    this.sessions.delete(guildId);
  }

  /**
   * Get session info for a guild
   */
  getSession(guildId: string): SessionInfo | undefined {
    return this.sessions.get(guildId);
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
