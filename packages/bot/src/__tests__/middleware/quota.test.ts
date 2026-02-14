/**
 * Tests for Quota Middleware
 *
 * Tests quota checking, role-based limits, estimate tuning, and atomic operations.
 * Note: Full integration tests would require a database connection.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { QuotaMiddleware } from '../../middleware/quota';

describe('QuotaMiddleware', () => {
  let mockAdminDb: any;
  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = {
      isGuildExempt: mock(async () => ({ quotaExempt: false, rateLimitExempt: false })),
      checkGuildQuota: mock(async () => ({ allowed: true, remaining: 10, max: 10 })),
      getUserDailyUsage: mock(async () => ({ textTokens: 0, images: 0, voiceMinutes: 0 })),
      getRoleTierQuota: mock(async () => ({ textTokens: 5000, images: 1, voiceMinutes: 0 })),
      incrementUsage: mock(async () => true),
      atomicIncrementUsage: mock(async () => ({ success: true, newTotal: 100, remaining: 4900 })),
      logQuotaAccuracy: mock(async () => {}),
      getQuotaAccuracyStats: mock(async () => ({ avgRatio: null, sampleCount: 0, stdDev: null })),
      markUserForResetNotification: mock(async () => {}),
      getGuildDailyUsage: mock(async () => null),
      getGuildQuota: mock(async () => null)
    };

    mockPermissions = {
      getUserRoleTier: mock(async () => 'member')
    };
  });

  describe('construction', () => {
    test('instantiates with admin database and permission manager', () => {
      const mockAdminDb = {} as any;
      const mockPermissions = {} as any;

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      expect(middleware).toBeDefined();
      expect(middleware).toBeInstanceOf(QuotaMiddleware);
    });
  });

  describe('checkQuota', () => {
    test('bypasses limits when guild is quotaExempt', async () => {
      mockAdminDb.isGuildExempt = mock(async () => ({ quotaExempt: true, rateLimitExempt: false }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.checkQuota(
        'guild1',
        'user1',
        { id: 'user1' } as any,
        'text_tokens',
        1000
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
      expect(result.max).toBe(Infinity);
      expect(mockAdminDb.checkGuildQuota).not.toHaveBeenCalled();
      expect(mockPermissions.getUserRoleTier).not.toHaveBeenCalled();
    });

    test('uses database-driven quotas instead of hardcoded values', async () => {
      mockAdminDb.getRoleTierQuota = mock(async () => ({
        textTokens: 10000,
        images: 2,
        voiceMinutes: 5
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.checkQuota(
        'guild1',
        'user1',
        { id: 'user1' } as any,
        'text_tokens',
        100
      );

      expect(result.allowed).toBe(true);
      expect(result.max).toBe(10000);
      expect(mockAdminDb.getRoleTierQuota).toHaveBeenCalledWith('guild1', 'member');
    });

    test('denies access when quota is 0 for restricted users', async () => {
      mockPermissions.getUserRoleTier = mock(async () => 'restricted');
      mockAdminDb.getRoleTierQuota = mock(async () => ({
        textTokens: 0,
        images: 0,
        voiceMinutes: 0
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.checkQuota(
        'guild1',
        'user1',
        { id: 'user1' } as any,
        'text_tokens',
        100
      );

      expect(result.allowed).toBe(false);
      expect(result.max).toBe(0);
      expect(result.reason).toContain("don't have access");
    });

    test('returns special message for voice access restriction', async () => {
      mockAdminDb.getRoleTierQuota = mock(async () => ({
        textTokens: 5000,
        images: 1,
        voiceMinutes: 0
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.checkQuota(
        'guild1',
        'user1',
        { id: 'user1' } as any,
        'voice_minutes',
        1
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Trusted role or higher');
    });

    test('denies when guild quota is exceeded', async () => {
      mockAdminDb.checkGuildQuota = mock(async () => ({
        allowed: false,
        remaining: 0,
        max: 50000
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.checkQuota(
        'guild1',
        'user1',
        { id: 'user1' } as any,
        'text_tokens',
        100
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Server has reached');
    });

    test('denies when user quota is exceeded', async () => {
      mockAdminDb.getUserDailyUsage = mock(async () => ({
        textTokens: 5000,
        images: 0,
        voiceMinutes: 0
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.checkQuota(
        'guild1',
        'user1',
        { id: 'user1' } as any,
        'text_tokens',
        100
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('daily');
      expect(result.reason).toContain('midnight UTC');
    });
  });

  describe('estimateResponseTokens', () => {
    test('uses default multiplier when no accuracy data exists', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokens(500);

      // Default: input * 0.3 + 150 base = 500 * 0.3 + 150 = 300
      expect(estimate).toBe(300);
    });

    test('clamps estimate to minimum of 50 tokens', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokens(0);

      expect(estimate).toBeGreaterThanOrEqual(50);
    });

    test('clamps estimate to maximum of 4000 tokens', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokens(100000);

      expect(estimate).toBeLessThanOrEqual(4000);
    });

    test('uses accuracy stats when sample count >= 10', async () => {
      mockAdminDb.getQuotaAccuracyStats = mock(async () => ({
        avgRatio: 0.5,
        sampleCount: 15,
        stdDev: 0.1
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokens(500);

      // With 0.5 ratio: 500 * 0.5 + 150 = 400
      expect(estimate).toBe(400);
    });
  });

  describe('recordUsage', () => {
    test('delegates to incrementUsage when no limit provided', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      await middleware.recordUsage('guild1', 'user1', 'text_tokens', 100);

      expect(mockAdminDb.incrementUsage).toHaveBeenCalledWith(
        'guild1',
        'user1',
        'text_tokens',
        100
      );
    });

    test('uses atomicIncrementUsage when limit is provided', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      await middleware.recordUsage('guild1', 'user1', 'text_tokens', 100, 5000);

      expect(mockAdminDb.atomicIncrementUsage).toHaveBeenCalledWith(
        'guild1',
        'user1',
        'text_tokens',
        100,
        5000
      );
    });
  });

  describe('recordUsageAtomic', () => {
    test('fetches user tier and quota before incrementing', async () => {
      mockAdminDb.getRoleTierQuota = mock(async () => ({
        textTokens: 10000,
        images: 2,
        voiceMinutes: 5
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.recordUsageAtomic(
        'guild1',
        'user1',
        { id: 'user1' } as any,
        'text_tokens',
        100
      );

      expect(result.success).toBe(true);
      expect(mockPermissions.getUserRoleTier).toHaveBeenCalled();
      expect(mockAdminDb.getRoleTierQuota).toHaveBeenCalled();
      expect(mockAdminDb.atomicIncrementUsage).toHaveBeenCalledWith(
        'guild1',
        'user1',
        'text_tokens',
        100,
        10000
      );
    });
  });

  describe('logAccuracy', () => {
    test('logs accuracy to database', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      await middleware.logAccuracy('guild1', 'user1', 500, 300, 287);

      expect(mockAdminDb.logQuotaAccuracy).toHaveBeenCalledWith('guild1', 'user1', 500, 300, 287);
    });
  });

  describe('markForResetNotification', () => {
    test('calls database method to mark user', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      await middleware.markForResetNotification('guild1', 'user1', 'channel1');

      expect(mockAdminDb.markUserForResetNotification).toHaveBeenCalledWith(
        'guild1',
        'user1',
        'channel1'
      );
    });
  });

  describe('getRemainingQuotas', () => {
    test('returns remaining quota for all types', async () => {
      mockAdminDb.getRoleTierQuota = mock(async () => ({
        textTokens: 5000,
        images: 1,
        voiceMinutes: 0
      }));
      mockAdminDb.getUserDailyUsage = mock(async () => ({
        textTokens: 1000,
        images: 0,
        voiceMinutes: 0
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.getRemainingQuotas('guild1', 'user1', { id: 'user1' } as any);

      expect(result.text_tokens.remaining).toBe(4000);
      expect(result.text_tokens.max).toBe(5000);
      expect(result.images.remaining).toBe(1);
      expect(result.images.max).toBe(1);
    });
  });

  describe('getGuildUsageSummary', () => {
    test('returns guild usage with defaults when no data', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const result = await middleware.getGuildUsageSummary('guild1');

      expect(result.textTokens.used).toBe(0);
      expect(result.textTokens.max).toBe(50000);
      expect(result.images.used).toBe(0);
      expect(result.images.max).toBe(5);
    });
  });
});
