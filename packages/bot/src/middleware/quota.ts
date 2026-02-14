import type { GuildMember } from 'discord.js';
import type { AdminAdapter } from '../database/admin-adapter';
import type { PermissionManager } from '../permissions/manager';
import { logger } from '@silo/core';

export type UsageType = 'text_tokens' | 'images' | 'voice_minutes';
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

// Guild-level max quotas (cannot exceed these)
const GUILD_MAX_QUOTAS = {
  text_tokens: 50000,
  images: 5,
  voice_minutes: 15
} as const;

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
   * Estimate response tokens based on input length
   * Uses 7-day rolling average from accuracy logs
   */
  async estimateResponseTokens(inputLength: number): Promise<number> {
    const multiplier = await this.getEstimateMultiplier();
    const estimated = Math.ceil(inputLength * multiplier) + DEFAULT_BASE_TOKENS;

    // Clamp to reasonable bounds (min 50, max 4000 for typical responses)
    return Math.max(50, Math.min(4000, estimated));
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
    // Fast path: guild exemptions
    const exemptions = await this.adminDb.isGuildExempt(guildId);
    if (exemptions.quotaExempt) {
      logger.debug('Quota check: guild exempt', { guildId, userId, type: usageType });
      return { allowed: true, remaining: Infinity, max: Infinity };
    }

    // Get user's role tier
    const tier = await this.permissions.getUserRoleTier(guildId, userId, member);

    // Get user's quota limit from database (guild-specific or global fallback)
    const quotaLimits = await this.adminDb.getRoleTierQuota(guildId, tier);
    const userLimit = this.getQuotaByType(quotaLimits, usageType);

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

    // Check guild quota first
    const guildCheck = await this.adminDb.checkGuildQuota(guildId, usageType, amount);
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

    // Get user's current daily usage
    const userUsage = await this.adminDb.getUserDailyUsage(guildId, userId);
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
        reason: `You've reached your daily ${this.formatUsageType(usageType)} limit. Resets at midnight UTC.`
      };
    }

    return {
      allowed: true,
      remaining: remaining - amount,
      max: userLimit
    };
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
    const tier = await this.permissions.getUserRoleTier(guildId, userId, member);
    const quotaLimits = await this.adminDb.getRoleTierQuota(guildId, tier);
    const userLimit = this.getQuotaByType(quotaLimits, usageType);

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
   * Get user's remaining quota for all types
   */
  async getRemainingQuotas(
    guildId: string,
    userId: string,
    member: GuildMember
  ): Promise<Record<UsageType, { remaining: number; max: number }>> {
    const tier = await this.permissions.getUserRoleTier(guildId, userId, member);
    const quotaLimits = await this.adminDb.getRoleTierQuota(guildId, tier);
    const userUsage = await this.adminDb.getUserDailyUsage(guildId, userId);

    const result: Record<UsageType, { remaining: number; max: number }> = {
      text_tokens: { remaining: 0, max: 0 },
      images: { remaining: 0, max: 0 },
      voice_minutes: { remaining: 0, max: 0 }
    };

    for (const usageType of ['text_tokens', 'images', 'voice_minutes'] as UsageType[]) {
      const max = this.getQuotaByType(quotaLimits, usageType);
      const used = userUsage ? this.getUserUsageByType(userUsage, usageType) : 0;
      result[usageType] = {
        remaining: Math.max(0, max - used),
        max
      };
    }

    return result;
  }

  /**
   * Get guild's daily usage summary
   */
  async getGuildUsageSummary(guildId: string): Promise<{
    textTokens: { used: number; max: number };
    images: { used: number; max: number };
    voiceMinutes: { used: number; max: number };
  }> {
    const usage = await this.adminDb.getGuildDailyUsage(guildId);
    const quota = await this.adminDb.getGuildQuota(guildId);

    return {
      textTokens: {
        used: usage?.textTokens || 0,
        max: quota?.textTokensMax || GUILD_MAX_QUOTAS.text_tokens
      },
      images: {
        used: usage?.images || 0,
        max: quota?.imagesMax || GUILD_MAX_QUOTAS.images
      },
      voiceMinutes: {
        used: usage?.voiceMinutes || 0,
        max: quota?.voiceMinutesMax || GUILD_MAX_QUOTAS.voice_minutes
      }
    };
  }

  /**
   * Get quota value by usage type from quota limits object
   */
  private getQuotaByType(
    quotaLimits: { textTokens: number; images: number; voiceMinutes: number },
    usageType: UsageType
  ): number {
    switch (usageType) {
      case 'text_tokens':
        return quotaLimits.textTokens;
      case 'images':
        return quotaLimits.images;
      case 'voice_minutes':
        return quotaLimits.voiceMinutes;
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
      default:
        return usageType;
    }
  }

  /**
   * Extract usage value by type from user usage object
   */
  private getUserUsageByType(
    usage: { textTokens: number; images: number; voiceMinutes: number },
    usageType: UsageType
  ): number {
    switch (usageType) {
      case 'text_tokens':
        return usage.textTokens;
      case 'images':
        return usage.images;
      case 'voice_minutes':
        return usage.voiceMinutes;
      default:
        return 0;
    }
  }
}
