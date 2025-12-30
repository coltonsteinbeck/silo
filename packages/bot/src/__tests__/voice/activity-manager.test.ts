import { describe, it, expect, beforeEach } from 'bun:test';
import { VoiceActivityManager } from '../../voice/activity-manager';

describe('VoiceActivityManager', () => {
  let manager: VoiceActivityManager;

  beforeEach(() => {
    manager = new VoiceActivityManager();
  });

  describe('initialization', () => {
    it('initializes with no activities', () => {
      expect(manager.hasActivity('guild-1', 'user-1')).toBe(false);
    });
  });

  describe('activity tracking', () => {
    it('starts a speaking activity', () => {
      const activity = manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      expect(activity.type).toBe('speaking');
      expect(activity.userId).toBe('user-1');
      expect(activity.guildId).toBe('guild-1');
      expect(activity.channelId).toBe('channel-1');
      expect(activity.startedAt).toBeDefined();
    });

    it('marks activity as tracked after start', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      expect(manager.hasActivity('guild-1', 'user-1')).toBe(true);
    });

    it('retrieves correct activity', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      const activity = manager.getActivity('guild-1', 'user-1');
      expect(activity?.type).toBe('speaking');
    });

    it('prevents duplicate activities for same user/guild', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      expect(() => manager.startActivity('guild-1', 'user-1', 'channel-2', 'listening')).toThrow();
    });

    it('allows same user in different guilds', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-2', 'user-1', 'channel-2', 'listening');

      expect(manager.hasActivity('guild-1', 'user-1')).toBe(true);
      expect(manager.hasActivity('guild-2', 'user-1')).toBe(true);
    });

    it('allows multiple users in same guild', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-1', 'user-2', 'channel-1', 'listening');

      expect(manager.hasActivity('guild-1', 'user-1')).toBe(true);
      expect(manager.hasActivity('guild-1', 'user-2')).toBe(true);
    });
  });

  describe('activity types', () => {
    it('supports speaking type', () => {
      const activity = manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      expect(activity.type).toBe('speaking');
    });

    it('supports listening type', () => {
      const activity = manager.startActivity('guild-1', 'user-1', 'channel-1', 'listening');
      expect(activity.type).toBe('listening');
    });

    it('supports music type', () => {
      const activity = manager.startActivity('guild-1', 'user-1', 'channel-1', 'music');
      expect(activity.type).toBe('music');
    });
  });

  describe('stopping activities', () => {
    it('stops an activity', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      const stopped = manager.stopActivity('guild-1', 'user-1');
      expect(stopped).toBe(true);
      expect(manager.hasActivity('guild-1', 'user-1')).toBe(false);
    });

    it('returns false when stopping non-existent activity', () => {
      const stopped = manager.stopActivity('guild-1', 'user-999');
      expect(stopped).toBe(false);
    });

    it('stops activity only for specific guild', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-2', 'user-1', 'channel-2', 'listening');

      manager.stopActivity('guild-1', 'user-1');

      expect(manager.hasActivity('guild-1', 'user-1')).toBe(false);
      expect(manager.hasActivity('guild-2', 'user-1')).toBe(true);
    });
  });

  describe('guild activities', () => {
    it('retrieves all activities for a guild', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-1', 'user-2', 'channel-2', 'listening');
      manager.startActivity('guild-2', 'user-3', 'channel-3', 'music');

      const guildActivities = manager.getGuildActivities('guild-1');
      expect(guildActivities.length).toBe(2);
      expect(guildActivities.every(a => a.guildId === 'guild-1')).toBe(true);
    });

    it('returns empty array for guild with no activities', () => {
      const guildActivities = manager.getGuildActivities('guild-999');
      expect(guildActivities.length).toBe(0);
    });

    it('clears all activities for a guild', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-1', 'user-2', 'channel-1', 'listening');
      manager.startActivity('guild-2', 'user-3', 'channel-2', 'music');

      const cleared = manager.clearGuild('guild-1');
      expect(cleared).toBe(2);
      expect(manager.hasActivity('guild-1', 'user-1')).toBe(false);
      expect(manager.hasActivity('guild-1', 'user-2')).toBe(false);
      expect(manager.hasActivity('guild-2', 'user-3')).toBe(true);
    });

    it('returns 0 when clearing guild with no activities', () => {
      const cleared = manager.clearGuild('guild-999');
      expect(cleared).toBe(0);
    });
  });

  describe('channel activities', () => {
    it('retrieves activities for a channel', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-1', 'user-2', 'channel-1', 'listening');
      manager.startActivity('guild-1', 'user-3', 'channel-2', 'music');

      const channelActivities = manager.getChannelActivities('guild-1', 'channel-1');
      expect(channelActivities.length).toBe(2);
      expect(channelActivities.every(a => a.channelId === 'channel-1')).toBe(true);
    });

    it('returns empty array for channel with no activities', () => {
      const channelActivities = manager.getChannelActivities('guild-1', 'channel-999');
      expect(channelActivities.length).toBe(0);
    });
  });

  describe('speaking count', () => {
    it('counts speaking users in a channel', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-1', 'user-2', 'channel-1', 'speaking');
      manager.startActivity('guild-1', 'user-3', 'channel-1', 'listening');

      const speakingCount = manager.getSpeakingCount('guild-1', 'channel-1');
      expect(speakingCount).toBe(2);
    });

    it('returns 0 if no speakers in channel', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'listening');
      const speakingCount = manager.getSpeakingCount('guild-1', 'channel-1');
      expect(speakingCount).toBe(0);
    });

    it('only counts speakers in specific channel', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-1', 'user-2', 'channel-2', 'speaking');

      const speakingCount = manager.getSpeakingCount('guild-1', 'channel-1');
      expect(speakingCount).toBe(1);
    });
  });

  describe('user activities', () => {
    it('clears all activities for a user across guilds', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      manager.startActivity('guild-2', 'user-1', 'channel-2', 'listening');
      manager.startActivity('guild-1', 'user-2', 'channel-1', 'music');

      const cleared = manager.clearUser('user-1');
      expect(cleared).toBe(2);
      expect(manager.hasActivity('guild-1', 'user-1')).toBe(false);
      expect(manager.hasActivity('guild-2', 'user-1')).toBe(false);
      expect(manager.hasActivity('guild-1', 'user-2')).toBe(true);
    });

    it('returns 0 when clearing non-existent user', () => {
      const cleared = manager.clearUser('user-999');
      expect(cleared).toBe(0);
    });
  });

  describe('activity duration', () => {
    it('calculates duration of ongoing activity', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      const duration = manager.getActivityDuration('guild-1', 'user-1');

      expect(duration).not.toBeNull();
      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it('returns null for non-existent activity', () => {
      const duration = manager.getActivityDuration('guild-1', 'user-999');
      expect(duration).toBeNull();
    });

    it('tracks increasing duration', async () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      const duration1 = manager.getActivityDuration('guild-1', 'user-1')!;

      await new Promise(resolve => setTimeout(resolve, 50));
      const duration2 = manager.getActivityDuration('guild-1', 'user-1')!;

      expect(duration2).toBeGreaterThan(duration1);
    });
  });

  describe('concurrent operations', () => {
    it('handles rapid activity creation', () => {
      for (let i = 0; i < 50; i++) {
        manager.startActivity('guild-1', `user-${i}`, 'channel-1', 'speaking');
      }

      for (let i = 0; i < 50; i++) {
        expect(manager.hasActivity('guild-1', `user-${i}`)).toBe(true);
      }
    });

    it('handles rapid guild cleanup', () => {
      for (let i = 0; i < 50; i++) {
        manager.startActivity('guild-1', `user-${i}`, 'channel-1', 'speaking');
      }

      const cleared = manager.clearGuild('guild-1');
      expect(cleared).toBe(50);
      expect(manager.getGuildActivities('guild-1').length).toBe(0);
    });

    it('handles rapid user cleanup', () => {
      for (let i = 0; i < 20; i++) {
        manager.startActivity(`guild-${i}`, 'user-1', `channel-${i}`, 'speaking');
      }

      const cleared = manager.clearUser('user-1');
      expect(cleared).toBe(20);

      for (let i = 0; i < 20; i++) {
        expect(manager.hasActivity(`guild-${i}`, 'user-1')).toBe(false);
      }
    });
  });

  describe('edge cases', () => {
    it('handles empty string guild and user ids gracefully', () => {
      // These are not typical but should not crash
      const activity = manager.startActivity('', '', '', 'speaking');
      expect(activity.guildId).toBe('');
      expect(activity.userId).toBe('');
    });

    it('retrieves activity immediately after start', () => {
      manager.startActivity('guild-1', 'user-1', 'channel-1', 'speaking');
      const activity = manager.getActivity('guild-1', 'user-1');
      expect(activity).toBeDefined();
      expect(activity?.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });
  });
});
