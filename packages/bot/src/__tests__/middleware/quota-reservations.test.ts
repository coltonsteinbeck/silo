/**
 * Tests for Quota Middleware
 *
 * Tests role-based limits, estimate tuning, and atomic reservations.
 * Note: Full integration tests would require a database connection.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { QuotaMiddleware } from '../../middleware/quota';

describe('QuotaMiddleware', () => {
  let mockAdminDb: any;
  let mockPermissions: any;

  beforeEach(() => {
    mockAdminDb = {
      getUserDailyUsage: mock(async () => ({
        textTokens: 0,
        images: 0,
        voiceMinutes: 0,
        visionTokens: 0,
        videoTokens: 0
      })),
      getRoleTierQuota: mock(async () => ({
        textTokens: 5000,
        images: 1,
        voiceMinutes: 0,
        visionTokens: 1000,
        videoTokens: 4
      })),
      reserveQuotaUsage: mock(async (request: any) => ({
        idempotencyKey: request.idempotencyKey,
        status: 'reserved',
        allowed: true,
        reason: null,
        requestedAmount: request.requestedAmount,
        reservedAmount: request.requestedAmount,
        actualAmount: null,
        remaining: 4000,
        userLimit: 5000,
        guildLimit: 50000,
        usageDate: '2026-08-14',
        quotaExempt: false,
        idempotent: false
      })),
      markQuotaUsageAttempted: mock(async (idempotencyKey: string) => ({
        idempotencyKey,
        status: 'attempted',
        reservedAmount: 1000,
        actualAmount: null,
        usageDate: '2026-08-14',
        idempotent: false
      })),
      recordQuotaUsageActual: mock(async (_idempotencyKey: string, _actualAmount: number) => {}),
      commitQuotaUsage: mock(async (idempotencyKey: string, actualAmount: number) => ({
        idempotencyKey,
        status: 'committed',
        reservedAmount: 1000,
        actualAmount,
        usageDate: '2026-08-14',
        idempotent: false
      })),
      releaseQuotaUsage: mock(async (idempotencyKey: string) => ({
        idempotencyKey,
        status: 'released',
        reservedAmount: 1000,
        actualAmount: null,
        usageDate: '2026-08-14',
        idempotent: false
      })),
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

  describe('estimateResponseTokensWithCap', () => {
    test('uses default multiplier when no accuracy data exists', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokensWithCap(500, 4000);

      // Default: input * 0.3 + 150 base = 500 * 0.3 + 150 = 300
      expect(estimate).toBe(300);
    });

    test('clamps estimate to minimum of 50 tokens', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokensWithCap(0, 4000);

      expect(estimate).toBeGreaterThanOrEqual(50);
    });

    test('clamps estimate to maximum of 4000 tokens', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokensWithCap(100000, 4000);

      expect(estimate).toBeLessThanOrEqual(4000);
    });

    test('caps estimate to the configured response token ceiling', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokensWithCap(5000, 400);

      expect(estimate).toBe(400);
    });

    test('respects a very small remaining token budget', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokensWithCap(5000, 17);

      expect(estimate).toBe(17);
    });

    test('uses accuracy stats when sample count >= 10', async () => {
      mockAdminDb.getQuotaAccuracyStats = mock(async () => ({
        avgRatio: 0.5,
        sampleCount: 15,
        stdDev: 0.1
      }));

      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const estimate = await middleware.estimateResponseTokensWithCap(500, 4000);

      // With 0.5 ratio: 500 * 0.5 + 150 = 400
      expect(estimate).toBe(400);
    });
  });

  describe('atomic reservation lifecycle', () => {
    test('returns successful paid output when recording actual usage fails', async () => {
      mockAdminDb.recordQuotaUsageActual.mockRejectedValue(new Error('Database unavailable'));
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const provider = mock(async () => ({ content: 'Paid answer' }));
      const result = await middleware.executeReserved({
        operationKey: 'message:recording-failure',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'text_tokens',
        requestedAmount: 500,
        minimumAmount: 1,
        execute: provider,
        getActualAmount: () => 73
      });
      expect(result).toMatchObject({
        allowed: true,
        value: { content: 'Paid answer' },
        commit: null,
        settlementPending: true
      });
      expect(provider).toHaveBeenCalledTimes(1);
      expect(mockAdminDb.commitQuotaUsage).not.toHaveBeenCalled();
      expect(mockAdminDb.releaseQuotaUsage).not.toHaveBeenCalled();
    });

    test('database insufficient_quota denial explains the daily limit', async () => {
      mockAdminDb.reserveQuotaUsage.mockResolvedValue({
        allowed: false,
        reason: 'insufficient_quota',
        status: 'released'
      });
      const result = await new QuotaMiddleware(mockAdminDb, mockPermissions).reserveQuota({
        operationKey: 'message:denied',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'text_tokens',
        requestedAmount: 500,
        minimumAmount: 1
      });
      expect(result).toMatchObject({
        allowed: false,
        reason: "You've reached your daily text token limit. Resets at midnight ET."
      });
    });
    test('does not execute paid work for a duplicate still-reserved operation', async () => {
      mockAdminDb.reserveQuotaUsage = mock(async () => ({
        idempotencyKey: 'discord:duplicate:search',
        status: 'reserved',
        allowed: false,
        reason: 'idempotency_key_already_reserved',
        requestedAmount: 500,
        reservedAmount: 500,
        remaining: 4000,
        userLimit: 5000,
        guildLimit: 50000,
        usageDate: '2026-08-14',
        quotaExempt: false
      }));
      const provider = mock(async () => ({ content: 'must not run' }));
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      const result = await middleware.executeReserved({
        operationKey: 'discord:duplicate:search',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'text_tokens',
        requestedAmount: 500,
        minimumAmount: 1,
        execute: provider,
        getActualAmount: () => 1
      });

      expect(result).toMatchObject({
        allowed: false,
        reason: 'This request is already being processed or has already completed.'
      });
      expect(provider).not.toHaveBeenCalled();
      expect(mockAdminDb.markQuotaUsageAttempted).not.toHaveBeenCalled();
    });

    test('denies before provider execution when the database cannot reserve the minimum', async () => {
      mockAdminDb.reserveQuotaUsage = mock(async () => ({
        idempotencyKey: 'message:1:primary',
        status: 'released',
        allowed: false,
        reason: 'user_limit',
        requestedAmount: 500,
        reservedAmount: 0,
        actualAmount: null,
        remaining: 0,
        userLimit: 5000,
        guildLimit: 50000,
        usageDate: '2026-08-14',
        quotaExempt: false,
        idempotent: false
      }));
      const provider = mock(async () => ({ content: 'must not run' }));
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      const result = await middleware.executeReserved({
        operationKey: 'message:1:primary',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'text_tokens',
        requestedAmount: 500,
        minimumAmount: 1,
        execute: provider,
        getActualAmount: () => 1
      });

      expect(result.allowed).toBe(false);
      expect(provider).not.toHaveBeenCalled();
      expect(mockAdminDb.markQuotaUsageAttempted).not.toHaveBeenCalled();
      expect(mockAdminDb.commitQuotaUsage).not.toHaveBeenCalled();
    });

    test('marks attempted before provider I/O and commits actual usage immediately on success', async () => {
      const events: string[] = [];
      mockAdminDb.markQuotaUsageAttempted = mock(async (idempotencyKey: string) => {
        events.push('attempted');
        return {
          idempotencyKey,
          status: 'attempted',
          reservedAmount: 500,
          actualAmount: null,
          usageDate: '2026-08-14',
          idempotent: false
        };
      });
      mockAdminDb.commitQuotaUsage = mock(async (idempotencyKey: string, actualAmount: number) => {
        events.push(`committed:${actualAmount}`);
        return {
          idempotencyKey,
          status: 'committed',
          reservedAmount: 500,
          actualAmount,
          usageDate: '2026-08-14',
          idempotent: false
        };
      });
      mockAdminDb.recordQuotaUsageActual = mock(
        async (_idempotencyKey: string, actualAmount: number) => {
          events.push(`reported:${actualAmount}`);
        }
      );
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      const result = await middleware.executeReserved({
        operationKey: 'message:2:primary',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'text_tokens',
        requestedAmount: 500,
        minimumAmount: 1,
        execute: async reservedAmount => {
          events.push(`provider:${reservedAmount}`);
          return { usage: 73 };
        },
        getActualAmount: value => value.usage
      });

      expect(result.allowed).toBe(true);
      expect(events).toEqual(['attempted', 'provider:500', 'reported:73', 'committed:73']);
      if (result.allowed) expect(result.settlementPending).toBe(false);
    });

    test('charges exact provider usage when it exceeds the admission reservation', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      const result = await middleware.executeReserved({
        operationKey: 'message:2:overage',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'vision_tokens',
        requestedAmount: 10,
        minimumAmount: 1,
        execute: async reservedAmount => ({ reservedAmount, usage: 17 }),
        getActualAmount: value => value.usage
      });

      expect(result).toMatchObject({
        allowed: true,
        actualAmount: 17,
        reservation: { reservedAmount: 10 },
        commit: { actualAmount: 17 }
      });
      expect(mockAdminDb.commitQuotaUsage).toHaveBeenCalledWith('message:2:overage', 17);
    });

    test('returns paid provider output when exact usage is durable but counter settlement is pending', async () => {
      mockAdminDb.commitQuotaUsage = mock(async () => {
        throw new Error('counter database unavailable');
      });
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      const result = await middleware.executeReserved({
        operationKey: 'message:2:pending-settlement',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'text_tokens',
        requestedAmount: 500,
        minimumAmount: 1,
        execute: async () => ({ content: 'paid provider response', usage: 73 }),
        getActualAmount: value => value.usage
      });

      expect(result).toMatchObject({
        allowed: true,
        value: { content: 'paid provider response' },
        actualAmount: 73,
        commit: null,
        settlementPending: true
      });
      expect(mockAdminDb.recordQuotaUsageActual).toHaveBeenCalledWith(
        'message:2:pending-settlement',
        73
      );
      expect(mockAdminDb.commitQuotaUsage).toHaveBeenCalledTimes(3);
    });

    test('records actual usage durably and retries an interrupted counter commit', async () => {
      mockAdminDb.commitQuotaUsage = mock()
        .mockRejectedValueOnce(new Error('temporary database disconnect'))
        .mockResolvedValueOnce({
          idempotencyKey: 'message:2:retry',
          status: 'committed',
          reservedAmount: 10,
          actualAmount: 17,
          usageDate: '2026-08-14',
          idempotent: false
        });
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const reservation = {
        idempotencyKey: 'message:2:retry',
        status: 'attempted' as const,
        allowed: true,
        reason: null,
        requestedAmount: 10,
        reservedAmount: 10,
        remaining: 0,
        userLimit: 10,
        guildLimit: 10,
        usageDate: '2026-08-14',
        quotaExempt: false
      };

      await expect(middleware.commitQuota(reservation, 17)).resolves.toMatchObject({
        status: 'committed',
        actualAmount: 17
      });
      expect(mockAdminDb.recordQuotaUsageActual).toHaveBeenCalledWith('message:2:retry', 17);
      expect(mockAdminDb.commitQuotaUsage).toHaveBeenCalledTimes(2);
    });

    test('rejects an actual amount outside the durable ledger integer bound', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      await expect(
        middleware.commitQuota(
          {
            idempotencyKey: 'message:2:overflow',
            status: 'reserved',
            allowed: true,
            reason: null,
            requestedAmount: 1,
            reservedAmount: 1,
            remaining: 0,
            userLimit: 1,
            guildLimit: 1,
            usageDate: '2026-08-14',
            quotaExempt: false
          },
          2_147_483_648
        )
      ).rejects.toThrow('Invalid actual quota amount');
      expect(mockAdminDb.commitQuotaUsage).not.toHaveBeenCalled();
    });

    test('commits the reserved amount when a provider reports zero usage', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      const result = await middleware.executeReserved({
        operationKey: 'message:2:zero-usage',
        guildId: 'guild1',
        userId: 'user1',
        member: { id: 'user1' } as any,
        usageType: 'text_tokens',
        requestedAmount: 500,
        minimumAmount: 1,
        execute: async () => ({ usage: 0 }),
        getActualAmount: value => value.usage
      });

      expect(result.allowed).toBe(true);
      expect(mockAdminDb.commitQuotaUsage).toHaveBeenCalledWith('message:2:zero-usage', 500);
    });

    test('keeps an attempted reservation pending when provider outcome is ambiguous', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      await expect(
        middleware.executeReserved({
          operationKey: 'message:3:primary',
          guildId: 'guild1',
          userId: 'user1',
          member: { id: 'user1' } as any,
          usageType: 'text_tokens',
          requestedAmount: 500,
          minimumAmount: 1,
          execute: async () => {
            throw new Error('provider timeout');
          },
          getActualAmount: () => 1
        })
      ).rejects.toThrow('provider timeout');

      expect(mockAdminDb.markQuotaUsageAttempted).toHaveBeenCalledTimes(1);
      expect(mockAdminDb.releaseQuotaUsage).not.toHaveBeenCalled();
      expect(mockAdminDb.commitQuotaUsage).not.toHaveBeenCalled();
    });

    test('releases only when the provider attempt transition never completes', async () => {
      mockAdminDb.markQuotaUsageAttempted = mock(async () => {
        throw new Error('database unavailable');
      });
      const provider = mock(async () => ({ usage: 1 }));
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      await expect(
        middleware.executeReserved({
          operationKey: 'message:4:primary',
          guildId: 'guild1',
          userId: 'user1',
          member: { id: 'user1' } as any,
          usageType: 'text_tokens',
          requestedAmount: 500,
          execute: provider,
          getActualAmount: value => value.usage
        })
      ).rejects.toThrow('database unavailable');

      expect(provider).not.toHaveBeenCalled();
      expect(mockAdminDb.releaseQuotaUsage).toHaveBeenCalledWith(
        'message:4:primary',
        'attempt_transition_failed'
      );
      expect(mockAdminDb.releaseQuotaUsage).toHaveBeenCalledTimes(1);
    });

    test('retries release when a pre-provider transition fails transiently', async () => {
      mockAdminDb.markQuotaUsageAttempted = mock(async () => {
        throw new Error('database unavailable');
      });
      mockAdminDb.releaseQuotaUsage = mock()
        .mockRejectedValueOnce(new Error('temporary release failure'))
        .mockResolvedValueOnce({
          idempotencyKey: 'message:4:release-retry',
          status: 'released',
          reservedAmount: 500,
          actualAmount: null,
          usageDate: '2026-08-14',
          idempotent: false
        });
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);

      await expect(
        middleware.executeReserved({
          operationKey: 'message:4:release-retry',
          guildId: 'guild1',
          userId: 'user1',
          member: { id: 'user1' } as any,
          usageType: 'text_tokens',
          requestedAmount: 500,
          execute: async () => ({ usage: 1 }),
          getActualAmount: value => value.usage
        })
      ).rejects.toThrow('database unavailable');

      expect(mockAdminDb.releaseQuotaUsage).toHaveBeenCalledTimes(2);
    });
  });

  describe('logAccuracy', () => {
    test('logs accuracy to database', async () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      await middleware.logAccuracy('guild1', 'user1', 500, 300, 287);

      expect(mockAdminDb.logQuotaAccuracy).toHaveBeenCalledWith('guild1', 'user1', 500, 300, 287);
    });
  });

  describe('getChargeableTextTokens', () => {
    test('prefers completion tokens for response-only billing', () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const billedTokens = middleware.getChargeableTextTokens(
        {
          promptTokens: 900,
          completionTokens: 120,
          totalTokens: 1020
        },
        'Short reply'
      );

      expect(billedTokens).toBe(120);
    });

    test('falls back to response length estimate when provider omits usage', () => {
      const middleware = new QuotaMiddleware(mockAdminDb, mockPermissions);
      const billedTokens = middleware.getChargeableTextTokens(
        undefined,
        'This is a fallback reply.'
      );

      expect(billedTokens).toBeGreaterThan(0);
      expect(billedTokens).toBe(Math.ceil('This is a fallback reply.'.length / 4));
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
});
