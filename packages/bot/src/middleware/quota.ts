import type { GuildMember } from 'discord.js';
import type { AdminAdapter } from '../database/admin-adapter';
import type { PermissionManager } from '../permissions/manager';

export type UsageType = 'text_tokens' | 'images' | 'voice_minutes';
export type RoleTier = 'admin' | 'moderator' | 'trusted' | 'member' | 'restricted';

interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  max: number;
  reason?: string;
}

// Default quotas per role tier (daily limits)
const DEFAULT_QUOTAS = {
  text_tokens: {
    member: 5000,
    trusted: 10000,
    moderator: 20000,
    admin: 50000,
    restricted: 0
  },
  images: {
    member: 1,
    trusted: 2,
    moderator: 3,
    admin: 5,
    restricted: 0
  },
  voice_minutes: {
    member: 0, // No voice for regular members
    trusted: 5,
    moderator: 10,
    admin: 15,
    restricted: 0
  }
} as const;

// Guild-level max quotas (cannot exceed these)
const GUILD_MAX_QUOTAS = {
  text_tokens: 50000,
  images: 5,
  voice_minutes: 15
} as const;

export class QuotaMiddleware {
  private adminDb: AdminAdapter;
  private permissions: PermissionManager;

  constructor(adminDb: AdminAdapter, permissions: PermissionManager) {
    this.adminDb = adminDb;
    this.permissions = permissions;
  }

  /**
   * Check if a user can perform an action based on their quota
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
      return { allowed: true, remaining: Infinity, max: Infinity };
    }

    // Get user's role tier
    const tier = await this.permissions.getUserRoleTier(guildId, userId, member);

    // Get user's quota limit based on role
    const userLimit = DEFAULT_QUOTAS[usageType][tier];

    // Special case: quota = 0 means no access
    if (userLimit === 0) {
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

    if (currentUsage + amount > userLimit) {
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
   * Record usage after an action is performed
   */
  async recordUsage(
    guildId: string,
    userId: string,
    usageType: UsageType,
    amount: number
  ): Promise<boolean> {
    return this.adminDb.incrementUsage(guildId, userId, usageType, amount);
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
    const userUsage = await this.adminDb.getUserDailyUsage(guildId, userId);

    const result: Record<UsageType, { remaining: number; max: number }> = {
      text_tokens: { remaining: 0, max: 0 },
      images: { remaining: 0, max: 0 },
      voice_minutes: { remaining: 0, max: 0 }
    };

    for (const usageType of ['text_tokens', 'images', 'voice_minutes'] as UsageType[]) {
      const max = DEFAULT_QUOTAS[usageType][tier];
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
