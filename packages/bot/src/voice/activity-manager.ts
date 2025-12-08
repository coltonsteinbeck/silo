/**
 * Manages voice activity state to prevent conflicts between different voice features.
 * Tracks which users are engaged in voice activities across guilds.
 */

type VoiceActivityType = 'speaking' | 'listening' | 'music';

interface VoiceActivity {
  type: VoiceActivityType;
  userId: string;
  guildId: string;
  channelId: string;
  startedAt: Date;
}

export class VoiceActivityManager {
  private activities: Map<string, VoiceActivity> = new Map(); // `${guildId}:${userId}` -> activity

  /**
   * Create a composite key for guild+user
   */
  private getKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
  }

  /**
   * Check if a user has an active voice activity in a guild
   */
  hasActivity(guildId: string, userId: string): boolean {
    return this.activities.has(this.getKey(guildId, userId));
  }

  /**
   * Get a user's current voice activity
   */
  getActivity(guildId: string, userId: string): VoiceActivity | undefined {
    return this.activities.get(this.getKey(guildId, userId));
  }

  /**
   * Start a voice activity for a user
   */
  startActivity(
    guildId: string,
    userId: string,
    channelId: string,
    type: VoiceActivityType
  ): VoiceActivity {
    const key = this.getKey(guildId, userId);
    
    // Check if user already has an activity
    if (this.activities.has(key)) {
      throw new Error('User already has an active voice activity');
    }

    const activity: VoiceActivity = {
      type,
      userId,
      guildId,
      channelId,
      startedAt: new Date()
    };

    this.activities.set(key, activity);
    return activity;
  }

  /**
   * Stop a user's voice activity
   */
  stopActivity(guildId: string, userId: string): boolean {
    return this.activities.delete(this.getKey(guildId, userId));
  }

  /**
   * Get all activities for a guild
   */
  getGuildActivities(guildId: string): VoiceActivity[] {
    const result: VoiceActivity[] = [];
    for (const [key, activity] of this.activities) {
      if (key.startsWith(`${guildId}:`)) {
        result.push(activity);
      }
    }
    return result;
  }

  /**
   * Get all activities for a channel
   */
  getChannelActivities(guildId: string, channelId: string): VoiceActivity[] {
    return this.getGuildActivities(guildId).filter(a => a.channelId === channelId);
  }

  /**
   * Get count of speaking users in a channel
   */
  getSpeakingCount(guildId: string, channelId: string): number {
    return this.getChannelActivities(guildId, channelId)
      .filter(a => a.type === 'speaking')
      .length;
  }

  /**
   * Clear all activities for a guild (e.g., when bot leaves)
   */
  clearGuild(guildId: string): number {
    let cleared = 0;
    for (const key of this.activities.keys()) {
      if (key.startsWith(`${guildId}:`)) {
        this.activities.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Clear all activities for a user across all guilds
   */
  clearUser(userId: string): number {
    let cleared = 0;
    for (const [key, activity] of this.activities) {
      if (activity.userId === userId) {
        this.activities.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Get duration of an activity in milliseconds
   */
  getActivityDuration(guildId: string, userId: string): number | null {
    const activity = this.getActivity(guildId, userId);
    if (!activity) return null;
    return Date.now() - activity.startedAt.getTime();
  }
}

// Singleton instance
export const voiceActivityManager = new VoiceActivityManager();
