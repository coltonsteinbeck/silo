import { Pool } from 'pg';
import {
  ServerConfig,
  AuditLog,
  ModAction,
  AnalyticsEvent,
  UserRole,
  ResponseFeedback,
  ChannelConfig,
  logger
} from '@silo/core';

export class AdminAdapter {
  constructor(private pool: Pool) {}

  // Server Configuration
  async getServerConfig(guildId: string): Promise<ServerConfig | null> {
    const result = await this.pool.query('SELECT * FROM server_config WHERE guild_id = $1', [
      guildId
    ]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      guildId: row.guild_id,
      defaultProvider: row.default_provider,
      autoThread: row.auto_thread,
      memoryRetentionDays: row.memory_retention_days,
      rateLimitMultiplier: row.rate_limit_multiplier,
      featuresEnabled: row.features_enabled,
      channelConfigs: row.channel_configs,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async setServerConfig(
    config: Partial<ServerConfig> & { guildId: string }
  ): Promise<ServerConfig> {
    const result = await this.pool.query(
      `INSERT INTO server_config (guild_id, default_provider, auto_thread, memory_retention_days, 
       rate_limit_multiplier, features_enabled, channel_configs)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (guild_id) 
       DO UPDATE SET 
         default_provider = COALESCE($2, server_config.default_provider),
         auto_thread = COALESCE($3, server_config.auto_thread),
         memory_retention_days = COALESCE($4, server_config.memory_retention_days),
         rate_limit_multiplier = COALESCE($5, server_config.rate_limit_multiplier),
         features_enabled = COALESCE($6, server_config.features_enabled),
         channel_configs = COALESCE($7, server_config.channel_configs),
         updated_at = NOW()
       RETURNING *`,
      [
        config.guildId,
        config.defaultProvider,
        config.autoThread,
        config.memoryRetentionDays,
        config.rateLimitMultiplier,
        config.featuresEnabled ? JSON.stringify(config.featuresEnabled) : null,
        config.channelConfigs ? JSON.stringify(config.channelConfigs) : null
      ]
    );

    const row = result.rows[0];
    return {
      guildId: row.guild_id,
      defaultProvider: row.default_provider,
      autoThread: row.auto_thread,
      memoryRetentionDays: row.memory_retention_days,
      rateLimitMultiplier: row.rate_limit_multiplier,
      featuresEnabled: row.features_enabled,
      channelConfigs: row.channel_configs,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async getChannelConfig(guildId: string, channelId: string): Promise<ChannelConfig | null> {
    const config = await this.getServerConfig(guildId);
    if (!config || !config.channelConfigs) return null;
    return config.channelConfigs[channelId] || null;
  }

  async setChannelConfig(
    guildId: string,
    channelId: string,
    channelConfig: ChannelConfig
  ): Promise<void> {
    const existing = await this.getServerConfig(guildId);
    const channelConfigs = existing?.channelConfigs || {};
    channelConfigs[channelId] = channelConfig;

    await this.setServerConfig({
      guildId,
      channelConfigs
    });
  }

  // Audit Logging
  async logAction(log: Omit<AuditLog, 'id' | 'createdAt'>): Promise<AuditLog> {
    const result = await this.pool.query(
      `INSERT INTO audit_logs (guild_id, user_id, action, target_id, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        log.guildId,
        log.userId,
        log.action,
        log.targetId,
        log.details ? JSON.stringify(log.details) : null
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      guildId: row.guild_id,
      userId: row.user_id,
      action: row.action,
      targetId: row.target_id,
      details: row.details,
      createdAt: new Date(row.created_at)
    };
  }

  async getAuditLogs(guildId: string, limit = 50): Promise<AuditLog[]> {
    const result = await this.pool.query(
      'SELECT * FROM audit_logs WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2',
      [guildId, limit]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      guildId: row.guild_id,
      userId: row.user_id,
      action: row.action,
      targetId: row.target_id,
      details: row.details,
      createdAt: new Date(row.created_at)
    }));
  }

  // Moderation Actions
  async logModAction(action: Omit<ModAction, 'id' | 'createdAt'>): Promise<ModAction> {
    const result = await this.pool.query(
      `INSERT INTO mod_actions (guild_id, moderator_id, target_user_id, action_type, reason, duration, message_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        action.guildId,
        action.moderatorId,
        action.targetUserId,
        action.actionType,
        action.reason,
        action.duration,
        action.messageCount
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      guildId: row.guild_id,
      moderatorId: row.moderator_id,
      targetUserId: row.target_user_id,
      actionType: row.action_type,
      reason: row.reason,
      duration: row.duration,
      messageCount: row.message_count,
      createdAt: new Date(row.created_at)
    };
  }

  async getModHistory(guildId: string, targetUserId?: string, limit = 50): Promise<ModAction[]> {
    const query = targetUserId
      ? 'SELECT * FROM mod_actions WHERE guild_id = $1 AND target_user_id = $2 ORDER BY created_at DESC LIMIT $3'
      : 'SELECT * FROM mod_actions WHERE guild_id = $1 ORDER BY created_at DESC LIMIT $2';

    const params = targetUserId ? [guildId, targetUserId, limit] : [guildId, limit];
    const result = await this.pool.query(query, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      guildId: row.guild_id,
      moderatorId: row.moderator_id,
      targetUserId: row.target_user_id,
      actionType: row.action_type,
      reason: row.reason,
      duration: row.duration,
      messageCount: row.message_count,
      createdAt: new Date(row.created_at)
    }));
  }

  // Analytics
  async logEvent(event: Omit<AnalyticsEvent, 'id' | 'createdAt'>): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO analytics_events (guild_id, user_id, event_type, command, provider, tokens_used, response_time_ms, success, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          event.guildId,
          event.userId,
          event.eventType,
          event.command,
          event.provider,
          event.tokensUsed,
          event.responseTimeMs,
          event.success,
          event.metadata ? JSON.stringify(event.metadata) : null
        ]
      );
    } catch (error) {
      logger.error('Failed to log analytics event:', error);
    }
  }

  async getAnalytics(guildId: string, since: Date): Promise<AnalyticsEvent[]> {
    const result = await this.pool.query(
      'SELECT * FROM analytics_events WHERE guild_id = $1 AND created_at >= $2 ORDER BY created_at DESC',
      [guildId, since]
    );

    return result.rows.map((row: any) => ({
      id: row.id,
      guildId: row.guild_id,
      userId: row.user_id,
      eventType: row.event_type,
      command: row.command,
      provider: row.provider,
      tokensUsed: row.tokens_used,
      responseTimeMs: row.response_time_ms,
      success: row.success,
      metadata: row.metadata,
      createdAt: new Date(row.created_at)
    }));
  }

  // User Roles
  async getUserRole(guildId: string, userId: string): Promise<UserRole | null> {
    const result = await this.pool.query(
      'SELECT * FROM user_roles WHERE guild_id = $1 AND user_id = $2',
      [guildId, userId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      guildId: row.guild_id,
      userId: row.user_id,
      roleTier: row.role_tier,
      grantedBy: row.granted_by,
      grantedAt: new Date(row.granted_at)
    };
  }

  async setUserRole(role: Omit<UserRole, 'grantedAt'>): Promise<UserRole> {
    const result = await this.pool.query(
      `INSERT INTO user_roles (guild_id, user_id, role_tier, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, user_id)
       DO UPDATE SET role_tier = $3, granted_by = $4, granted_at = NOW()
       RETURNING *`,
      [role.guildId, role.userId, role.roleTier, role.grantedBy]
    );

    const row = result.rows[0];
    return {
      guildId: row.guild_id,
      userId: row.user_id,
      roleTier: row.role_tier,
      grantedBy: row.granted_by,
      grantedAt: new Date(row.granted_at)
    };
  }

  // Response Feedback
  async logFeedback(feedback: Omit<ResponseFeedback, 'id' | 'createdAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO response_feedback (guild_id, channel_id, message_id, user_id, feedback_type, original_provider)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        feedback.guildId,
        feedback.channelId,
        feedback.messageId,
        feedback.userId,
        feedback.feedbackType,
        feedback.originalProvider
      ]
    );
  }

  async getFeedbackStats(guildId: string, since: Date): Promise<Record<string, number>> {
    const result = await this.pool.query(
      `SELECT feedback_type, COUNT(*) as count 
       FROM response_feedback 
       WHERE guild_id = $1 AND created_at >= $2 
       GROUP BY feedback_type`,
      [guildId, since]
    );

    const stats: Record<string, number> = {};
    for (const row of result.rows) {
      stats[row.feedback_type] = parseInt(row.count);
    }
    return stats;
  }
}
