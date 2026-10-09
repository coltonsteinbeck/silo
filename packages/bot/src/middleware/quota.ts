import type { GuildMember } from 'discord.js';
import type { AdminAdapter } from '../database/admin-adapter';
import type { PermissionManager } from '../permissions/manager';
import type { UserRole } from '@silo/core';
import { logger } from '@silo/core';
import type { QuotaReservationLifecycleRow, QuotaReservationRow } from '../database/admin-adapter';

export type UsageType =
  'text_tokens' | 'images' | 'voice_minutes' | 'vision_tokens' | 'video_tokens';
export type RoleTier = 'admin' | 'moderator' | 'trusted' | 'member' | 'restricted';

interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  max: number;
  reason?: string;
}

interface AtomicRecordResult {
  success: boolean;
  newTotal: number;
  remaining: number;
}

interface TokenUsageMetrics {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface QuotaReservationRequest {
  operationKey: string;
  guildId: string;
  userId: string;
  member: GuildMember;
  usageType: UsageType;
  requestedAmount: number;
  minimumAmount?: number;
}

export type QuotaReservationDecision =
  | {
      allowed: true;
      reservation: QuotaReservationRow;
      remaining: number;
      max: number;
    }
  | {
      allowed: false;
      reason: string;
      denialCode: string;
      remaining: number;
      max: number;
    };

export type ReservedQuotaExecution<T> =
  | {
      allowed: true;
      value: T;
      reservation: QuotaReservationRow;
      commit: QuotaReservationLifecycleRow | null;
      actualAmount: number;
      settlementPending: boolean;
    }
  | Extract<QuotaReservationDecision, { allowed: false }>;

const MAX_DATABASE_QUOTA_AMOUNT = 2_147_483_647;
const QUOTA_TRANSITION_ATTEMPTS = 3;
const QUOTA_TRANSITION_RETRY_DELAYS_MS = [25, 75] as const;

// Estimate tuning constants
const DEFAULT_ESTIMATE_RATIO = 0.3; // Default: 0.3 tokens per input character
const DEFAULT_BASE_TOKENS = 150; // Base tokens for response overhead
const ESTIMATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

export class QuotaMiddleware {
  private adminDb: AdminAdapter;
  private permissions: PermissionManager;

  // Cache for estimate multiplier (recalculated from 7-day data)
  private estimateMultiplierCache: { value: number; timestamp: number } | null = null;

  constructor(adminDb: AdminAdapter, permissions: PermissionManager) {
    this.adminDb = adminDb;
    this.permissions = permissions;
  }

  private resolveRoleTier(member: GuildMember, customRole: UserRole | null): RoleTier {
    if (customRole) {
      return customRole.roleTier;
    }

    return this.permissions.resolveRoleTierFromMember(member);
  }

  private async resolveReservationRoleTier(
    guildId: string,
    userId: string,
    member: GuildMember
  ): Promise<RoleTier> {
    const adminDb = this.adminDb as AdminAdapter & {
      getUserRole?: (guildId: string, userId: string) => Promise<UserRole | null>;
    };
    const customRole = adminDb.getUserRole ? await adminDb.getUserRole(guildId, userId) : null;
    const resolver = (
      this.permissions as unknown as {
        resolveRoleTierFromMember?: (member: GuildMember) => RoleTier;
      }
    ).resolveRoleTierFromMember;

    return typeof resolver === 'function'
      ? this.resolveRoleTier(member, customRole)
      : await this.permissions.getUserRoleTier(guildId, userId, member);
  }

  /**
   * Reserves quota atomically before a paid provider call. Duplicate operation keys cannot authorize a second call.
   */
  async reserveQuota(request: QuotaReservationRequest): Promise<QuotaReservationDecision> {
    const requestedAmount = Math.ceil(request.requestedAmount);
    const minimumAmount = Math.ceil(request.minimumAmount ?? requestedAmount);
    if (
      !request.operationKey ||
      request.operationKey.length > 200 ||
      !Number.isSafeInteger(requestedAmount) ||
      !Number.isSafeInteger(minimumAmount) ||
      requestedAmount < 1 ||
      minimumAmount < 1 ||
      requestedAmount > MAX_DATABASE_QUOTA_AMOUNT ||
      minimumAmount > MAX_DATABASE_QUOTA_AMOUNT ||
      minimumAmount > requestedAmount
    ) {
      logger.error('Quota reservation rejected invalid application request', {
        guildId: request.guildId,
        userId: request.userId,
        type: request.usageType,
        requestedAmount: request.requestedAmount,
        minimumAmount: request.minimumAmount
      });
      return {
        allowed: false,
        reason: 'Quota data is temporarily unavailable. Please try again shortly.',
        denialCode: 'invalid_request',
        remaining: 0,
        max: 0
      };
    }

    try {
      const roleTier = await this.resolveReservationRoleTier(
        request.guildId,
        request.userId,
        request.member
      );
      const reservation = await this.adminDb.reserveQuotaUsage({
        idempotencyKey: request.operationKey,
        guildId: request.guildId,
        userId: request.userId,
        roleTier,
        resource: request.usageType,
        requestedAmount,
        minimumAmount
      });

      if (!reservation.allowed || reservation.status !== 'reserved') {
        const denialCode = reservation.reason || `reservation_${reservation.status}`;
        return {
          allowed: false,
          reason: this.formatReservationDenial(request.usageType, denialCode),
          denialCode,
          remaining: Math.max(0, reservation.remaining),
          max: Math.max(0, Math.min(reservation.userLimit, reservation.guildLimit))
        };
      }

      logger.debug('Quota reserved', {
        guildId: request.guildId,
        userId: request.userId,
        type: request.usageType,
        requestedAmount,
        reservedAmount: reservation.reservedAmount,
        remaining: reservation.remaining,
        quotaExempt: reservation.quotaExempt
      });
      return {
        allowed: true,
        reservation,
        remaining: reservation.remaining,
        max: Math.min(reservation.userLimit, reservation.guildLimit)
      };
    } catch (error) {
      logger.error('Quota reservation failed closed', {
        guildId: request.guildId,
        userId: request.userId,
        type: request.usageType,
        errorType: error instanceof Error ? error.name : 'unknown'
      });
      return {
        allowed: false,
        reason: 'Quota service is temporarily unavailable. Please try again in a moment.',
        denialCode: 'service_unavailable',
        remaining: 0,
        max: 0
      };
    }
  }

  async markQuotaAttempted(reservation: QuotaReservationRow): Promise<void> {
    const transition = await this.adminDb.markQuotaUsageAttempted(reservation.idempotencyKey);
    if (transition.status !== 'attempted') {
      throw new Error(`Unexpected quota attempt status: ${transition.status}`);
    }
  }

  async commitQuota(
    reservation: QuotaReservationRow,
    actualAmount: number
  ): Promise<QuotaReservationLifecycleRow> {
    const normalizedAmount = this.normalizeActualQuotaAmount(reservation, actualAmount);
    await this.recordActualQuotaUsage(reservation, normalizedAmount);
    return this.finalizeQuotaCommit(reservation, normalizedAmount);
  }

  private normalizeActualQuotaAmount(
    reservation: QuotaReservationRow,
    actualAmount: number
  ): number {
    const normalizedAmount = Math.ceil(actualAmount);
    if (
      !Number.isSafeInteger(normalizedAmount) ||
      normalizedAmount < 1 ||
      normalizedAmount > MAX_DATABASE_QUOTA_AMOUNT
    ) {
      throw new Error('Invalid actual quota amount');
    }
    if (normalizedAmount > reservation.reservedAmount) {
      logger.warn('Provider usage exceeded its admission reservation; charging exact usage', {
        event: 'quota_actual_overage',
        reservedAmount: reservation.reservedAmount,
        actualAmount: normalizedAmount,
        overageAmount: normalizedAmount - reservation.reservedAmount
      });
    }
    return normalizedAmount;
  }

  private async recordActualQuotaUsage(
    reservation: QuotaReservationRow,
    normalizedAmount: number
  ): Promise<void> {
    await this.retryQuotaTransition('record_actual', () =>
      this.adminDb.recordQuotaUsageActual(reservation.idempotencyKey, normalizedAmount)
    );
  }

  private async finalizeQuotaCommit(
    reservation: QuotaReservationRow,
    normalizedAmount: number
  ): Promise<QuotaReservationLifecycleRow> {
    const transition = await this.retryQuotaTransition('commit', () =>
      this.adminDb.commitQuotaUsage(reservation.idempotencyKey, normalizedAmount)
    );
    if (transition.status !== 'committed') {
      throw new Error(`Unexpected quota commit status: ${transition.status}`);
    }
    return transition;
  }

  private async retryQuotaTransition<T>(operation: string, execute: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= QUOTA_TRANSITION_ATTEMPTS; attempt += 1) {
      try {
        return await execute();
      } catch (error) {
        lastError = error;
        if (attempt === QUOTA_TRANSITION_ATTEMPTS) break;
        logger.warn('Retrying durable quota lifecycle transition', {
          operation,
          attempt,
          errorType: error instanceof Error ? error.name : typeof error
        });
        await new Promise(resolve =>
          setTimeout(resolve, QUOTA_TRANSITION_RETRY_DELAYS_MS[attempt - 1] ?? 75)
        );
      }
    }
    throw lastError;
  }

  async releaseUnattemptedQuota(reservation: QuotaReservationRow, reason: string): Promise<void> {
    const transition = await this.retryQuotaTransition('release', () =>
      this.adminDb.releaseQuotaUsage(reservation.idempotencyKey, reason)
    );
    if (transition.status !== 'released') {
      throw new Error(`Unexpected quota release status: ${transition.status}`);
    }
  }

  /**
   * Executes one bounded provider call under an atomic quota reservation.
   * Provider errors leave the attempted reservation for conservative database
   * reconciliation because the application cannot prove whether billing began.
   */
  async executeReserved<T>(
    params: QuotaReservationRequest & {
      beforeAttempt?: () => void | Promise<void>;
      execute: (reservedAmount: number) => Promise<T>;
      getActualAmount: (value: T) => number;
    }
  ): Promise<ReservedQuotaExecution<T>> {
    const decision = await this.reserveQuota(params);
    if (!decision.allowed) {
      return decision;
    }

    const { reservation } = decision;
    if (params.beforeAttempt) {
      try {
        await params.beforeAttempt();
      } catch (error) {
        try {
          await this.releaseUnattemptedQuota(reservation, 'pre_attempt_check_failed');
        } catch (releaseError) {
          logger.error('Failed to release quota after pre-attempt check error', {
            guildId: params.guildId,
            userId: params.userId,
            type: params.usageType,
            errorType: releaseError instanceof Error ? releaseError.name : 'unknown'
          });
        }
        throw error;
      }
    }
    try {
      await this.markQuotaAttempted(reservation);
    } catch (error) {
      try {
        await this.releaseUnattemptedQuota(reservation, 'attempt_transition_failed');
      } catch (releaseError) {
        logger.error('Failed to release quota after attempt transition error', {
          guildId: params.guildId,
          userId: params.userId,
          type: params.usageType,
          errorType: releaseError instanceof Error ? releaseError.name : 'unknown'
        });
      }
      throw error;
    }

    let value: T;
    try {
      value = await params.execute(reservation.reservedAmount);
    } catch (error) {
      logger.warn(
        'Paid provider call failed with an attempted reservation pending reconciliation',
        {
          guildId: params.guildId,
          userId: params.userId,
          type: params.usageType,
          reservedAmount: reservation.reservedAmount,
          errorType: error instanceof Error ? error.name : 'unknown'
        }
      );
      throw error;
    }

    let actualAmount = reservation.reservedAmount;
    try {
      const candidate = Math.ceil(params.getActualAmount(value));
      if (Number.isSafeInteger(candidate) && candidate >= 1) {
        actualAmount = candidate;
      } else {
        logger.error('Provider returned invalid quota usage; committing reserved amount', {
          guildId: params.guildId,
          userId: params.userId,
          type: params.usageType,
          reservedAmount: reservation.reservedAmount
        });
      }
    } catch (error) {
      logger.error('Provider usage extraction failed; committing reserved amount', {
        guildId: params.guildId,
        userId: params.userId,
        type: params.usageType,
        reservedAmount: reservation.reservedAmount,
        errorType: error instanceof Error ? error.name : 'unknown'
      });
    }

    // Persist the exact provider usage before attempting the counter update.
    // Once recorded, a failed commit is safely recoverable by the global
    // reconciler and must not discard an already-paid successful response.
    actualAmount = this.normalizeActualQuotaAmount(reservation, actualAmount);
    await this.recordActualQuotaUsage(reservation, actualAmount);
    try {
      const commit = await this.finalizeQuotaCommit(reservation, actualAmount);
      return {
        allowed: true,
        value,
        reservation,
        commit,
        actualAmount,
        settlementPending: false
      };
    } catch (error) {
      logger.error('Quota counter commit deferred to durable reconciliation', {
        guildId: params.guildId,
        userId: params.userId,
        type: params.usageType,
        actualAmount,
        errorType: error instanceof Error ? error.name : typeof error
      });
      return {
        allowed: true,
        value,
        reservation,
        commit: null,
        actualAmount,
        settlementPending: true
      };
    }
  }

  /**
   * Get the estimate multiplier from 7-day accuracy data (cached for 1 hour)
   */
  private async getEstimateMultiplier(): Promise<number> {
    const now = Date.now();

    // Return cached value if still valid
    if (
      this.estimateMultiplierCache &&
      now - this.estimateMultiplierCache.timestamp < ESTIMATE_CACHE_TTL_MS
    ) {
      return this.estimateMultiplierCache.value;
    }

    try {
      const stats = await this.adminDb.getQuotaAccuracyStats(7);

      if (stats.avgRatio && stats.sampleCount >= 10) {
        // Use the average ratio from actual data
        this.estimateMultiplierCache = {
          value: stats.avgRatio,
          timestamp: now
        };
        logger.debug('Estimate multiplier updated from accuracy data', {
          avgRatio: stats.avgRatio,
          sampleCount: stats.sampleCount,
          stdDev: stats.stdDev
        });
        return stats.avgRatio;
      }
    } catch (error) {
      logger.warn('Failed to get accuracy stats for estimate multiplier:', error);
    }

    // Fall back to default
    this.estimateMultiplierCache = {
      value: DEFAULT_ESTIMATE_RATIO,
      timestamp: now
    };
    return DEFAULT_ESTIMATE_RATIO;
  }

  /**
   * Estimate response tokens based on input length, capped to the caller's max output size.
   */
  async estimateResponseTokensWithCap(inputLength: number, maxTokens: number): Promise<number> {
    const multiplier = await this.getEstimateMultiplier();
    const estimated = Math.ceil(inputLength * multiplier) + DEFAULT_BASE_TOKENS;
    const safeMaxTokens = Math.max(1, Math.floor(maxTokens));
    const minimumEstimate = Math.min(50, safeMaxTokens);

    return Math.max(minimumEstimate, Math.min(safeMaxTokens, estimated));
  }

  /**
   * Bill text quotas against response tokens only, falling back conservatively if usage is missing.
   */
  getChargeableTextTokens(usage: TokenUsageMetrics | undefined, responseContent: string): number {
    if (usage && Number.isFinite(usage.completionTokens) && (usage.completionTokens ?? 0) >= 0) {
      return usage.completionTokens ?? 0;
    }

    if (usage && Number.isFinite(usage.totalTokens) && (usage.totalTokens ?? 0) >= 0) {
      return usage.totalTokens ?? 0;
    }

    const fallbackEstimate = Math.ceil(responseContent.trim().length / 4);
    return Math.max(1, fallbackEstimate);
  }

  /**
   * Check if a user can perform an action based on their quota
   * Now uses database-driven quotas instead of hardcoded values
   */
  async checkQuota(
    guildId: string,
    userId: string,
    member: GuildMember,
    usageType: UsageType,
    amount: number = 1
  ): Promise<QuotaCheckResult> {
    const exemptions = await this.adminDb.isGuildExempt(guildId);

    // Fast path: guild exemptions
    if (exemptions.quotaExempt) {
      logger.debug('Quota check: guild exempt', { guildId, userId, type: usageType });
      return { allowed: true, remaining: Infinity, max: Infinity };
    }

    const adminDb = this.adminDb as AdminAdapter & {
      getUserRole?: (guildId: string, userId: string) => Promise<UserRole | null>;
    };
    const resolveRoleTierFromMember = (
      this.permissions as unknown as {
        resolveRoleTierFromMember?: (member: GuildMember) => RoleTier;
      }
    ).resolveRoleTierFromMember;

    try {
      const [customRole, guildCheck, userUsage] = await Promise.all([
        adminDb.getUserRole ? adminDb.getUserRole(guildId, userId) : Promise.resolve(null),
        this.adminDb.checkGuildQuota(guildId, usageType, amount),
        this.adminDb.getUserDailyUsage(guildId, userId)
      ]);

      // Get user's role tier
      const tier =
        typeof resolveRoleTierFromMember === 'function'
          ? this.resolveRoleTier(member, customRole)
          : await this.permissions.getUserRoleTier(guildId, userId, member);

      // Get user's quota limit from database (guild-specific or global fallback)
      const quotaLimits = await this.adminDb.getRoleTierQuota(guildId, tier);
      const userLimit = this.getQuotaByType(quotaLimits, usageType);

      if (!Number.isFinite(userLimit) || userLimit < 0) {
        logger.error('Quota check failed closed due to invalid user limit', {
          guildId,
          userId,
          tier,
          type: usageType,
          userLimit
        });
        return {
          allowed: false,
          remaining: 0,
          max: 0,
          reason: 'Quota data is temporarily unavailable. Please try again shortly.'
        };
      }

      // Special case: quota = 0 means no access
      if (userLimit === 0) {
        logger.debug('Quota check: no access', { guildId, userId, tier, type: usageType });
        if (usageType === 'voice_minutes') {
          return {
            allowed: false,
            remaining: 0,
            max: 0,
            reason: 'Voice features require Trusted role or higher. Ask an admin for access.'
          };
        }
        return {
          allowed: false,
          remaining: 0,
          max: 0,
          reason: `You don't have access to ${this.formatUsageType(usageType)}s.`
        };
      }

      if (!guildCheck.allowed) {
        logger.warn('Quota check: guild limit reached', {
          guildId,
          type: usageType,
          remaining: guildCheck.remaining,
          max: guildCheck.max
        });
        return {
          allowed: false,
          remaining: guildCheck.remaining,
          max: guildCheck.max,
          reason: `Server has reached its daily ${this.formatUsageType(usageType)} limit.`
        };
      }

      const currentUsage = userUsage ? this.getUserUsageByType(userUsage, usageType) : 0;
      const remaining = Math.max(0, userLimit - currentUsage);
      const percentUsed = userLimit > 0 ? Math.round((currentUsage / userLimit) * 100) : 0;

      // Log quota status
      logger.debug('Quota check', {
        guildId,
        userId,
        tier,
        type: usageType,
        current: currentUsage,
        requested: amount,
        remaining,
        max: userLimit,
        percentUsed
      });

      // Warn when quota is running low (<20% remaining)
      if (percentUsed >= 80 && remaining > 0) {
        logger.warn('User quota low', {
          guildId,
          userId,
          type: usageType,
          remaining,
          max: userLimit,
          percentUsed
        });
      }

      if (currentUsage + amount > userLimit) {
        logger.error('Quota exceeded', {
          guildId,
          userId,
          type: usageType,
          requested: amount,
          current: currentUsage,
          remaining,
          max: userLimit
        });
        return {
          allowed: false,
          remaining,
          max: userLimit,
          reason: `You've reached your daily ${this.formatUsageType(usageType)} limit. Resets at midnight ET.`
        };
      }

      return {
        allowed: true,
        remaining: remaining - amount,
        max: userLimit,
        reason: undefined
      };
    } catch (error) {
      logger.error('Quota check failed closed due to lookup error', {
        guildId,
        userId,
        type: usageType,
        error
      });
      return {
        allowed: false,
        remaining: 0,
        max: 0,
        reason: 'Quota service is temporarily unavailable. Please try again in a moment.'
      };
    }
  }

  /**
   * Record usage after an action is performed using atomic increment
   * Returns detailed result for logging
   */
  async recordUsage(
    guildId: string,
    userId: string,
    usageType: UsageType,
    amount: number,
    userLimit?: number
  ): Promise<boolean> {
    // If no limit provided, get it from database - fall back to legacy method
    if (userLimit === undefined) {
      return this.adminDb.incrementUsage(guildId, userId, usageType, amount);
    }

    const result = await this.adminDb.atomicIncrementUsage(
      guildId,
      userId,
      usageType,
      amount,
      userLimit
    );

    logger.debug('Usage recorded', {
      guildId,
      userId,
      type: usageType,
      amount,
      success: result.success,
      newTotal: result.newTotal,
      remaining: result.remaining
    });

    return result.success;
  }

  /**
   * Record usage with atomic increment and return detailed result
   */
  async recordUsageAtomic(
    guildId: string,
    userId: string,
    member: GuildMember,
    usageType: UsageType,
    amount: number
  ): Promise<AtomicRecordResult> {
    try {
      const tier = await this.permissions.getUserRoleTier(guildId, userId, member);
      const quotaLimits = await this.adminDb.getRoleTierQuota(guildId, tier);
      const userLimit = this.getQuotaByType(quotaLimits, usageType);

      if (!Number.isFinite(userLimit) || userLimit < 0) {
        logger.error('Atomic usage record failed due to invalid user limit', {
          guildId,
          userId,
          tier,
          type: usageType,
          userLimit
        });
        return { success: false, newTotal: 0, remaining: 0 };
      }

      const result = await this.adminDb.atomicIncrementUsage(
        guildId,
        userId,
        usageType,
        amount,
        userLimit
      );

      logger.debug('Usage recorded (atomic)', {
        guildId,
        userId,
        tier,
        type: usageType,
        amount,
        success: result.success,
        newTotal: result.newTotal,
        remaining: result.remaining
      });

      return result;
    } catch (error) {
      logger.error('Atomic usage record failed', {
        guildId,
        userId,
        type: usageType,
        amount,
        error
      });
      return { success: false, newTotal: 0, remaining: 0 };
    }
  }

  /**
   * Log quota accuracy for estimate tuning
   */
  async logAccuracy(
    guildId: string,
    userId: string,
    inputLength: number,
    estimatedTokens: number,
    actualTokens: number
  ): Promise<void> {
    const difference = actualTokens - estimatedTokens;
    const percentError = estimatedTokens > 0 ? Math.round((difference / estimatedTokens) * 100) : 0;

    logger.debug('Token usage accuracy', {
      guildId,
      userId,
      inputLength,
      estimated: estimatedTokens,
      actual: actualTokens,
      difference,
      percentError: `${percentError}%`
    });

    await this.adminDb.logQuotaAccuracy(
      guildId,
      userId,
      inputLength,
      estimatedTokens,
      actualTokens
    );
  }

  /**
   * Mark user for reset notification when quota is exhausted
   */
  async markForResetNotification(
    guildId: string,
    userId: string,
    channelId: string
  ): Promise<void> {
    await this.adminDb.markUserForResetNotification(guildId, userId, channelId);
    logger.debug('User marked for reset notification', { guildId, userId, channelId });
  }

  /**
   * Get quota value by usage type from quota limits object
   */
  private getQuotaByType(
    quotaLimits: {
      textTokens: number;
      images: number;
      voiceMinutes: number;
      visionTokens: number;
      videoTokens: number;
    },
    usageType: UsageType
  ): number {
    switch (usageType) {
      case 'text_tokens':
        return quotaLimits.textTokens;
      case 'images':
        return quotaLimits.images;
      case 'voice_minutes':
        return quotaLimits.voiceMinutes;
      case 'vision_tokens':
        return quotaLimits.visionTokens;
      case 'video_tokens':
        return quotaLimits.videoTokens;
      default:
        return 0;
    }
  }

  /**
   * Format usage type for display
   */
  private formatUsageType(usageType: UsageType): string {
    switch (usageType) {
      case 'text_tokens':
        return 'text token';
      case 'images':
        return 'image generation';
      case 'voice_minutes':
        return 'voice minute';
      case 'vision_tokens':
        return 'vision token';
      case 'video_tokens':
        return 'video token';
      default:
        return usageType;
    }
  }

  /**
   * Extract usage value by type from user usage object
   */
  private getUserUsageByType(
    usage: {
      textTokens: number;
      images: number;
      voiceMinutes: number;
      visionTokens: number;
      videoTokens: number;
    },
    usageType: UsageType
  ): number {
    switch (usageType) {
      case 'text_tokens':
        return usage.textTokens;
      case 'images':
        return usage.images;
      case 'voice_minutes':
        return usage.voiceMinutes;
      case 'vision_tokens':
        return usage.visionTokens;
      case 'video_tokens':
        return usage.videoTokens;
      default:
        return 0;
    }
  }
  private formatReservationDenial(usageType: UsageType, denialCode: string): string {
    if (denialCode === 'guild_limit') {
      return `Server has reached its daily ${this.formatUsageType(usageType)} limit.`;
    }
    if (usageType === 'voice_minutes' && denialCode === 'role_disabled') {
      return 'Voice features require Trusted role or higher. Ask an admin for access.';
    }
    if (denialCode === 'user_limit' || denialCode === 'role_disabled') {
      return `You've reached your daily ${this.formatUsageType(usageType)} limit. Resets at midnight ET.`;
    }
    if (
      denialCode.startsWith('reservation_') ||
      denialCode.startsWith('idempotency_key_already_') ||
      denialCode === 'idempotency_conflict'
    ) {
      return 'This request is already being processed or has already completed.';
    }
    return 'Quota service is temporarily unavailable. Please try again in a moment.';
  }
}
