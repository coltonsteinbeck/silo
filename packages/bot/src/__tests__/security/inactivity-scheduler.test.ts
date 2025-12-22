/**
 * Tests for Inactivity Scheduler
 *
 * Tests guild inactivity detection, warnings, and eviction logic.
 */

import { describe, test, expect, beforeEach } from 'bun:test';

// Types for testing
interface InactiveGuild {
  guild_id: string;
  guild_name: string;
  warning_channel_id: string | null;
  days_inactive: number;
  owner_id: string;
}

// Mock deployment config
const mockDeploymentConfig = {
  isProduction: false,
  isDevelopment: true,
  isSelfHosted: true
};

// Mock Inactivity Scheduler for testing pure logic
class MockInactivityScheduler {
  private isRunning = false;
  private lastCheck: Date | null = null;

  // Configurable thresholds for testing
  private readonly WARNING_THRESHOLD_DAYS = 25;
  private readonly EVICTION_THRESHOLD_DAYS = 30;

  start(): boolean {
    if (this.isRunning) {
      return false;
    }

    if (mockDeploymentConfig.isSelfHosted) {
      return false;
    }

    this.isRunning = true;
    return true;
  }

  stop(): void {
    this.isRunning = false;
  }

  isSchedulerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Determine if a guild needs a warning (25-29 days inactive)
   */
  needsWarning(daysInactive: number): boolean {
    return (
      daysInactive >= this.WARNING_THRESHOLD_DAYS && daysInactive < this.EVICTION_THRESHOLD_DAYS
    );
  }

  /**
   * Determine if a guild should be evicted (30+ days inactive)
   */
  shouldEvict(daysInactive: number): boolean {
    return daysInactive >= this.EVICTION_THRESHOLD_DAYS;
  }

  /**
   * Calculate warning urgency (days until eviction)
   */
  getDaysUntilEviction(daysInactive: number): number {
    return Math.max(0, this.EVICTION_THRESHOLD_DAYS - daysInactive);
  }

  /**
   * Categorize guilds by inactivity status
   */
  categorizeGuilds(guilds: InactiveGuild[]): {
    warning: InactiveGuild[];
    eviction: InactiveGuild[];
    active: InactiveGuild[];
  } {
    return {
      warning: guilds.filter(g => this.needsWarning(g.days_inactive)),
      eviction: guilds.filter(g => this.shouldEvict(g.days_inactive)),
      active: guilds.filter(g => g.days_inactive < this.WARNING_THRESHOLD_DAYS)
    };
  }

  setLastCheck(date: Date): void {
    this.lastCheck = date;
  }

  getLastCheck(): Date | null {
    return this.lastCheck;
  }
}

describe('InactivityScheduler', () => {
  let scheduler: MockInactivityScheduler;

  beforeEach(() => {
    scheduler = new MockInactivityScheduler();
    mockDeploymentConfig.isSelfHosted = false;
    mockDeploymentConfig.isProduction = true;
  });

  describe('start/stop', () => {
    test('can start scheduler in hosted mode', () => {
      mockDeploymentConfig.isSelfHosted = false;

      const started = scheduler.start();

      expect(started).toBe(true);
      expect(scheduler.isSchedulerRunning()).toBe(true);
    });

    test('does not start in self-hosted mode', () => {
      mockDeploymentConfig.isSelfHosted = true;

      const started = scheduler.start();

      expect(started).toBe(false);
      expect(scheduler.isSchedulerRunning()).toBe(false);
    });

    test('prevents double-start', () => {
      scheduler.start();
      const secondStart = scheduler.start();

      expect(secondStart).toBe(false);
    });

    test('can stop running scheduler', () => {
      scheduler.start();
      scheduler.stop();

      expect(scheduler.isSchedulerRunning()).toBe(false);
    });
  });

  describe('needsWarning', () => {
    test('returns false for active guilds (< 25 days)', () => {
      expect(scheduler.needsWarning(0)).toBe(false);
      expect(scheduler.needsWarning(10)).toBe(false);
      expect(scheduler.needsWarning(24)).toBe(false);
    });

    test('returns true for guilds in warning range (25-29 days)', () => {
      expect(scheduler.needsWarning(25)).toBe(true);
      expect(scheduler.needsWarning(27)).toBe(true);
      expect(scheduler.needsWarning(29)).toBe(true);
    });

    test('returns false for guilds past eviction threshold (30+ days)', () => {
      expect(scheduler.needsWarning(30)).toBe(false);
      expect(scheduler.needsWarning(35)).toBe(false);
    });
  });

  describe('shouldEvict', () => {
    test('returns false for active guilds (< 30 days)', () => {
      expect(scheduler.shouldEvict(0)).toBe(false);
      expect(scheduler.shouldEvict(25)).toBe(false);
      expect(scheduler.shouldEvict(29)).toBe(false);
    });

    test('returns true for guilds at eviction threshold (30+ days)', () => {
      expect(scheduler.shouldEvict(30)).toBe(true);
      expect(scheduler.shouldEvict(35)).toBe(true);
      expect(scheduler.shouldEvict(100)).toBe(true);
    });
  });

  describe('getDaysUntilEviction', () => {
    test('returns days remaining for active guilds', () => {
      expect(scheduler.getDaysUntilEviction(0)).toBe(30);
      expect(scheduler.getDaysUntilEviction(10)).toBe(20);
      expect(scheduler.getDaysUntilEviction(25)).toBe(5);
    });

    test('returns 0 for guilds at or past threshold', () => {
      expect(scheduler.getDaysUntilEviction(30)).toBe(0);
      expect(scheduler.getDaysUntilEviction(35)).toBe(0);
    });
  });

  describe('categorizeGuilds', () => {
    test('correctly categorizes active guilds', () => {
      const guilds: InactiveGuild[] = [
        {
          guild_id: '1',
          guild_name: 'Active',
          warning_channel_id: null,
          days_inactive: 5,
          owner_id: 'o1'
        }
      ];

      const result = scheduler.categorizeGuilds(guilds);

      expect(result.active).toHaveLength(1);
      expect(result.warning).toHaveLength(0);
      expect(result.eviction).toHaveLength(0);
    });

    test('correctly categorizes warning guilds', () => {
      const guilds: InactiveGuild[] = [
        {
          guild_id: '1',
          guild_name: 'Warning',
          warning_channel_id: null,
          days_inactive: 27,
          owner_id: 'o1'
        }
      ];

      const result = scheduler.categorizeGuilds(guilds);

      expect(result.active).toHaveLength(0);
      expect(result.warning).toHaveLength(1);
      expect(result.eviction).toHaveLength(0);
    });

    test('correctly categorizes eviction guilds', () => {
      const guilds: InactiveGuild[] = [
        {
          guild_id: '1',
          guild_name: 'Evict',
          warning_channel_id: null,
          days_inactive: 35,
          owner_id: 'o1'
        }
      ];

      const result = scheduler.categorizeGuilds(guilds);

      expect(result.active).toHaveLength(0);
      expect(result.warning).toHaveLength(0);
      expect(result.eviction).toHaveLength(1);
    });

    test('handles mixed guild statuses', () => {
      const guilds: InactiveGuild[] = [
        {
          guild_id: '1',
          guild_name: 'Active1',
          warning_channel_id: null,
          days_inactive: 5,
          owner_id: 'o1'
        },
        {
          guild_id: '2',
          guild_name: 'Active2',
          warning_channel_id: null,
          days_inactive: 15,
          owner_id: 'o2'
        },
        {
          guild_id: '3',
          guild_name: 'Warning1',
          warning_channel_id: null,
          days_inactive: 25,
          owner_id: 'o3'
        },
        {
          guild_id: '4',
          guild_name: 'Warning2',
          warning_channel_id: null,
          days_inactive: 29,
          owner_id: 'o4'
        },
        {
          guild_id: '5',
          guild_name: 'Evict1',
          warning_channel_id: null,
          days_inactive: 30,
          owner_id: 'o5'
        },
        {
          guild_id: '6',
          guild_name: 'Evict2',
          warning_channel_id: null,
          days_inactive: 45,
          owner_id: 'o6'
        }
      ];

      const result = scheduler.categorizeGuilds(guilds);

      expect(result.active).toHaveLength(2);
      expect(result.warning).toHaveLength(2);
      expect(result.eviction).toHaveLength(2);
    });

    test('handles empty guild list', () => {
      const result = scheduler.categorizeGuilds([]);

      expect(result.active).toHaveLength(0);
      expect(result.warning).toHaveLength(0);
      expect(result.eviction).toHaveLength(0);
    });
  });

  describe('last check tracking', () => {
    test('tracks last check time', () => {
      const checkTime = new Date();
      scheduler.setLastCheck(checkTime);

      expect(scheduler.getLastCheck()).toBe(checkTime);
    });

    test('returns null when never checked', () => {
      expect(scheduler.getLastCheck()).toBeNull();
    });
  });
});
