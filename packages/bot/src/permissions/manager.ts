import { GuildMember, PermissionFlagsBits } from 'discord.js';
import { AdminAdapter } from '../database/admin-adapter';
import { ROLE_RATE_LIMITS, RateLimits } from '@silo/core';

export class PermissionManager {
  constructor(private adminAdapter: AdminAdapter) {}

  async getUserRoleTier(
    guildId: string,
    userId: string,
    member: GuildMember
  ): Promise<'admin' | 'moderator' | 'trusted' | 'member' | 'restricted'> {
    // Check custom role assignment first
    const customRole = await this.adminAdapter.getUserRole(guildId, userId);
    if (customRole) {
      return customRole.roleTier;
    }

    // Check Discord permissions
    if (member.permissions.has(PermissionFlagsBits.Administrator)) {
      return 'admin';
    }

    if (
      member.permissions.has([
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.ManageMessages
      ])
    ) {
      return 'moderator';
    }

    // Check if user has been timed out or has restricted role
    if (member.communicationDisabledUntil && member.communicationDisabledUntil > new Date()) {
      return 'restricted';
    }

    // Default to member
    return 'member';
  }

  async getRateLimits(guildId: string, userId: string, member: GuildMember): Promise<RateLimits> {
    const tier = await this.getUserRoleTier(guildId, userId, member);
    const baseLimits = ROLE_RATE_LIMITS[tier];

    // Apply server-specific multiplier
    const config = await this.adminAdapter.getServerConfig(guildId);
    const multiplier = config?.rateLimitMultiplier || 1.0;

    return {
      commands: Math.floor(baseLimits.commands * multiplier),
      ai: Math.floor(baseLimits.ai * multiplier),
      video: Math.floor(baseLimits.video * multiplier),
      search: Math.floor(baseLimits.search * multiplier)
    };
  }

  async isAdmin(guildId: string, userId: string, member: GuildMember): Promise<boolean> {
    const tier = await this.getUserRoleTier(guildId, userId, member);
    return tier === 'admin';
  }

  async isModerator(guildId: string, userId: string, member: GuildMember): Promise<boolean> {
    const tier = await this.getUserRoleTier(guildId, userId, member);
    return tier === 'admin' || tier === 'moderator';
  }

  async canModerate(guildId: string, userId: string, member: GuildMember): Promise<boolean> {
    return this.isModerator(guildId, userId, member);
  }
}
