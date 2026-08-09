import { logger } from '@silo/core';

export type GuildVoiceActivityType = 'speech' | 'radio';
export type GuildVoiceLeaseToken = symbol;

export const GUILD_VOICE_RESERVATION_TTL_MS = 30_000;

export interface GuildVoiceActivity<T = unknown> {
  type: GuildVoiceActivityType;
  channelId: string;
  data: T | null;
  startedAt: number;
  reserved: boolean;
  ownerToken: GuildVoiceLeaseToken;
}

export type GuildVoiceReservation =
  | { acquired: true; token: GuildVoiceLeaseToken }
  | {
      acquired: false;
      conflictType: GuildVoiceActivityType;
      channelId: string;
      reserved: boolean;
    };

/**
 * Coordinates guild-wide ownership of Discord voice connections.
 *
 * Silo can host several realtime speakers in one speech session, but a guild
 * may not run speech and radio concurrently. Startup reservations are written
 * synchronously so two async startup paths cannot both claim the same guild.
 */
export class GuildVoiceCoordinator {
  private readonly activities = new Map<string, GuildVoiceActivity>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly reservationTtlMs: number = GUILD_VOICE_RESERVATION_TTL_MS
  ) {}

  private pruneExpiredReservation(guildId: string): boolean {
    const activity = this.activities.get(guildId);
    if (
      !activity?.reserved ||
      !Number.isFinite(activity.startedAt) ||
      this.now() - activity.startedAt < this.reservationTtlMs
    ) {
      return false;
    }

    this.activities.delete(guildId);
    logger.warn('[GuildVoiceCoordinator] Expired abandoned voice startup reservation', {
      activityType: activity.type
    });
    return true;
  }

  getActiveActivity<T = unknown>(guildId: string): GuildVoiceActivity<T> | null {
    this.pruneExpiredReservation(guildId);
    return (this.activities.get(guildId) as GuildVoiceActivity<T> | undefined) ?? null;
  }

  canJoinActive(guildId: string, type: GuildVoiceActivityType, channelId: string): boolean {
    const activity = this.getActiveActivity(guildId);
    return Boolean(
      activity && !activity.reserved && activity.type === type && activity.channelId === channelId
    );
  }

  reserveExclusive(
    guildId: string,
    type: GuildVoiceActivityType,
    channelId: string
  ): GuildVoiceReservation {
    this.pruneExpiredReservation(guildId);
    const existing = this.activities.get(guildId);
    if (existing) {
      return {
        acquired: false,
        conflictType: existing.type,
        channelId: existing.channelId,
        reserved: existing.reserved
      };
    }

    const token = Symbol(`${type}:${guildId}`);
    this.activities.set(guildId, {
      type,
      channelId,
      data: null,
      startedAt: this.now(),
      reserved: true,
      ownerToken: token
    });
    return { acquired: true, token };
  }

  renew(guildId: string, token: GuildVoiceLeaseToken): boolean {
    this.pruneExpiredReservation(guildId);
    const activity = this.activities.get(guildId);
    if (!activity || !activity.reserved || activity.ownerToken !== token) {
      return false;
    }

    activity.startedAt = this.now();
    return true;
  }

  commit<T>(guildId: string, token: GuildVoiceLeaseToken, data: T): boolean {
    this.pruneExpiredReservation(guildId);
    const activity = this.activities.get(guildId);
    if (!activity || !activity.reserved || activity.ownerToken !== token) {
      return false;
    }

    activity.data = data;
    activity.reserved = false;
    activity.startedAt = this.now();
    logger.info('[GuildVoiceCoordinator] Voice activity started', {
      activityType: activity.type
    });
    return true;
  }

  release(guildId: string, token: GuildVoiceLeaseToken): boolean {
    const activity = this.activities.get(guildId);
    if (!activity || activity.ownerToken !== token) {
      return false;
    }

    this.activities.delete(guildId);
    logger.info('[GuildVoiceCoordinator] Voice activity released', {
      activityType: activity.type
    });
    return true;
  }

  stop<T>(guildId: string, type: GuildVoiceActivityType, expectedData?: T): boolean {
    const activity = this.activities.get(guildId);
    if (!activity || activity.reserved || activity.type !== type) {
      return false;
    }
    if (expectedData !== undefined && activity.data !== expectedData) {
      return false;
    }

    this.activities.delete(guildId);
    logger.info('[GuildVoiceCoordinator] Voice activity stopped', {
      activityType: activity.type
    });
    return true;
  }

  clear(): void {
    this.activities.clear();
  }
}

export const guildVoiceCoordinator = new GuildVoiceCoordinator();
