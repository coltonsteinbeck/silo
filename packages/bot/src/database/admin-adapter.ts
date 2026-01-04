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
  constructor(private pool: Pool) { }

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

  // Alerts Channel (stored in guild_registry.warning_channel_id)
  async getAlertsChannel(guildId: string): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT warning_channel_id FROM guild_registry WHERE guild_id = $1',
      [guildId]
    );
    return result.rows[0]?.warning_channel_id ?? null;
  }

  async setAlertsChannel(guildId: string, channelId: string | null): Promise<void> {
    await this.pool.query(`UPDATE guild_registry SET warning_channel_id = $2 WHERE guild_id = $1`, [
      guildId,
      channelId
    ]);
  }

  // System Prompts
  /**
   * Get the system prompt for a guild
   * @param guildId - The guild ID
   * @param forVoice - Whether to get the voice-specific prompt (falls back to regular if not set)
   */
  async getSystemPrompt(
    guildId: string,
    forVoice = false
  ): Promise<{ prompt: string | null; enabled: boolean }> {
    const result = await this.pool.query(
      `SELECT system_prompt, voice_system_prompt, system_prompt_enabled 
       FROM server_config WHERE guild_id = $1`,
      [guildId]
    );

    if (result.rows.length === 0) {
      return { prompt: null, enabled: true };
    }

    const row = result.rows[0];
    const enabled = row.system_prompt_enabled ?? true;

    if (forVoice && row.voice_system_prompt) {
      return { prompt: row.voice_system_prompt, enabled };
    }

    return { prompt: row.system_prompt, enabled };
  }

  /**
   * Set the system prompt for a guild
   * @param guildId - The guild ID
   * @param prompt - The system prompt text (null to clear)
   * @param options - Additional options
   */
  async setSystemPrompt(
    guildId: string,
    prompt: string | null,
    options: { forVoice?: boolean; enabled?: boolean } = {}
  ): Promise<void> {
    const { forVoice = false, enabled } = options;
    const column = forVoice ? 'voice_system_prompt' : 'system_prompt';

    // Build query dynamically based on what we're updating
    let query: string;
    let params: (string | boolean | null)[];

    if (enabled !== undefined) {
      query = `
        INSERT INTO server_config (guild_id, ${column}, system_prompt_enabled)
        VALUES ($1, $2, $3)
        ON CONFLICT (guild_id) 
        DO UPDATE SET ${column} = $2, system_prompt_enabled = $3, updated_at = NOW()
      `;
      params = [guildId, prompt, enabled];
    } else {
      query = `
        INSERT INTO server_config (guild_id, ${column})
        VALUES ($1, $2)
        ON CONFLICT (guild_id) 
        DO UPDATE SET ${column} = $2, updated_at = NOW()
      `;
      params = [guildId, prompt];
    }

    await this.pool.query(query, params);

    // Log the change
    await this.logAction({
      guildId,
      userId: 'system',
      action: forVoice ? 'voice_system_prompt_updated' : 'system_prompt_updated',
      details: {
        promptLength: prompt?.length ?? 0,
        enabled: enabled ?? true,
        clearedPrompt: prompt === null
      }
    });
  }

  /**
   * Toggle system prompt enabled/disabled
   */
  async toggleSystemPrompt(guildId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE server_config SET system_prompt_enabled = $2, updated_at = NOW() WHERE guild_id = $1`,
      [guildId, enabled]
    );
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
      const cost = await this.calculateEventCost({
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens ?? 0,
        images: event.command === 'draw' ? 1 : 0,
        voiceMinutes: event.durationMs ? event.durationMs / 60000 : 0
      });

      await this.pool.query(
        `INSERT INTO analytics_events (guild_id, user_id, event_type, command, provider, model, input_tokens, output_tokens, tokens_used, response_time_ms, success, metadata, estimated_cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          event.guildId,
          event.userId,
          event.eventType,
          event.command,
          event.provider,
          event.model ?? null,
          event.inputTokens ?? 0,
          event.outputTokens ?? 0,
          event.tokensUsed ?? 0,
          event.responseTimeMs ?? null,
          event.success,
          event.metadata ? JSON.stringify(event.metadata) : null,
          cost
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
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      tokensUsed: row.tokens_used,
      estimatedCostUsd: row.estimated_cost_usd,
      responseTimeMs: row.response_time_ms,
      success: row.success,
      metadata: row.metadata,
      createdAt: new Date(row.created_at)
    }));
  }

  async getGuildCostAggregate(guildId: string): Promise<{
    inputTokens: number;
    outputTokens: number;
    images: number;
    totalCost: number;
    textCostUsd: number;
    imageCostUsd: number;
    voiceCostUsd: number;
    totalVoiceMinutes: number;
    providerBreakdown: Record<string, number>;
  }> {
    const result = await this.pool.query(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(images), 0) AS images,
         COALESCE(SUM(provider_cost), 0) AS total_cost,
         COALESCE(SUM(text_cost), 0) AS text_cost,
         COALESCE(SUM(image_cost), 0) AS image_cost,
         COALESCE(SUM(voice_cost), 0) AS voice_cost,
         COALESCE(SUM(voice_minutes), 0) AS voice_minutes,
         COALESCE(
           jsonb_object_agg(provider, provider_cost) FILTER (WHERE provider IS NOT NULL),
           '{}'::jsonb
         ) AS provider_breakdown
       FROM (
         SELECT provider,
                COALESCE(SUM(COALESCE(estimated_cost_usd, 0)), 0) AS provider_cost,
                SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(output_tokens, 0)) AS output_tokens,
                SUM(CASE WHEN command = 'draw' AND success THEN 1 ELSE 0 END) AS images,
                COALESCE(SUM(CASE WHEN command NOT IN ('draw', 'speak') THEN COALESCE(estimated_cost_usd, 0) ELSE 0 END), 0) AS text_cost,
                COALESCE(SUM(CASE WHEN command = 'draw' THEN COALESCE(estimated_cost_usd, 0) ELSE 0 END), 0) AS image_cost,
                COALESCE(SUM(CASE WHEN command = 'speak' THEN COALESCE(estimated_cost_usd, 0) ELSE 0 END), 0) AS voice_cost,
                COALESCE(SUM(CASE WHEN command = 'speak' THEN COALESCE(duration_ms, 0) / 60000.0 ELSE 0 END), 0) AS voice_minutes
           FROM analytics_events
          WHERE guild_id = $1
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY provider
       ) AS per_provider;`,
      [guildId]
    );

    const row = result.rows[0] || {};
    return {
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      images: Number(row.images) || 0,
      totalCost: Number(row.total_cost) || 0,
      textCostUsd: Number(row.text_cost) || 0,
      imageCostUsd: Number(row.image_cost) || 0,
      voiceCostUsd: Number(row.voice_cost) || 0,
      totalVoiceMinutes: Number(row.voice_minutes) || 0,
      providerBreakdown: row.provider_breakdown || {}
    };
  }

  async upsertGuildCostSummary(guildId: string): Promise<void> {
    const agg = await this.getGuildCostAggregate(guildId);
    const periodStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const periodEnd = new Date();

    await this.pool.query(
      `INSERT INTO guild_cost_summary (
         guild_id, period_start, period_end, total_input_tokens, total_output_tokens,
         total_images, total_voice_minutes, text_cost_usd, image_cost_usd, voice_cost_usd,
         provider_breakdown, last_updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (guild_id)
       DO UPDATE SET
         period_start = EXCLUDED.period_start,
         period_end = EXCLUDED.period_end,
         total_input_tokens = EXCLUDED.total_input_tokens,
         total_output_tokens = EXCLUDED.total_output_tokens,
         total_images = EXCLUDED.total_images,
         total_voice_minutes = EXCLUDED.total_voice_minutes,
         text_cost_usd = EXCLUDED.text_cost_usd,
         image_cost_usd = EXCLUDED.image_cost_usd,
         voice_cost_usd = EXCLUDED.voice_cost_usd,
         provider_breakdown = EXCLUDED.provider_breakdown,
         last_updated_at = NOW()`,
      [
        guildId,
        periodStart,
        periodEnd,
        agg.inputTokens,
        agg.outputTokens,
        agg.images,
        agg.totalVoiceMinutes,
        agg.textCostUsd,
        agg.imageCostUsd,
        agg.voiceCostUsd,
        JSON.stringify(agg.providerBreakdown)
      ]
    );
  }

  // --- Cost helpers ---
  async calculateEventCost(params: {
    provider?: string;
    model?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    images?: number;
    voiceMinutes?: number;
  }): Promise<number> {
    const provider = params.provider || 'unknown';
    const model = params.model || 'unknown';
    const input = params.inputTokens ?? 0;
    const output = params.outputTokens ?? 0;
    const images = params.images ?? 0;
    const voice = params.voiceMinutes ?? 0;

    // Fetch latest pricing for provider/model; fall back to zero if absent
    const priceResult = await this.pool.query(
      `SELECT input_cost_per_1k, output_cost_per_1k, image_cost, voice_cost_per_minute
         FROM provider_pricing
        WHERE provider = $1 AND model = $2
        ORDER BY effective_from DESC
        LIMIT 1`,
      [provider, model]
    );

    if (priceResult.rows.length === 0) {
      logger.warn(
        `Pricing not found for provider="${provider}" model="${model}"; falling back to cost=$0`
      );
      return 0;
    }

    const price = priceResult.rows[0];
    const costTokens =
      (input / 1000) * (price.input_cost_per_1k || 0) +
      (output / 1000) * (price.output_cost_per_1k || 0);
    const costImages = images * (price.image_cost || 0);
    const costVoice = voice * (price.voice_cost_per_minute || 0);

    return Number((costTokens + costImages + costVoice).toFixed(6));
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

  // User Feedback (from /feedback command)
  async submitFeedback(feedback: {
    guildId: string;
    userId: string;
    username: string;
    feedbackType: 'bug' | 'feature' | 'general' | 'praise';
    content: string;
    context: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_feedback (guild_id, user_id, username, feedback_type, content, context)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        feedback.guildId,
        feedback.userId,
        feedback.username,
        feedback.feedbackType,
        feedback.content,
        feedback.context
      ]
    );
  }

  // Quota Management
  async getGuildQuota(guildId: string): Promise<{
    textTokensMax: number;
    imagesMax: number;
    voiceMinutesMax: number;
  } | null> {
    const result = await this.pool.query('SELECT * FROM guild_quotas WHERE guild_id = $1', [
      guildId
    ]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    // Fixed: use correct column names (daily_* instead of *_max)
    return {
      textTokensMax: row.daily_text_tokens ?? row.text_tokens_max ?? 50000,
      imagesMax: row.daily_images ?? row.images_max ?? 5,
      voiceMinutesMax: row.daily_voice_minutes ?? row.voice_minutes_max ?? 15
    };
  }

  async isGuildExempt(
    guildId: string
  ): Promise<{ quotaExempt: boolean; rateLimitExempt: boolean }> {
    const result = await this.pool.query(
      `SELECT quota_exempt, rate_limit_exempt FROM guild_quotas WHERE guild_id = $1`,
      [guildId]
    );

    if (result.rows.length === 0) {
      return { quotaExempt: false, rateLimitExempt: false };
    }

    const row = result.rows[0];
    return {
      quotaExempt: row.quota_exempt === true,
      rateLimitExempt: row.rate_limit_exempt === true
    };
  }

  async setGuildQuota(
    guildId: string,
    quota: {
      textTokensMax?: number;
      imagesMax?: number;
      voiceMinutesMax?: number;
    }
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO guild_quotas (guild_id, text_tokens_max, images_max, voice_minutes_max)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id)
       DO UPDATE SET 
         text_tokens_max = COALESCE($2, guild_quotas.text_tokens_max),
         images_max = COALESCE($3, guild_quotas.images_max),
         voice_minutes_max = COALESCE($4, guild_quotas.voice_minutes_max),
         updated_at = NOW()`,
      [guildId, quota.textTokensMax, quota.imagesMax, quota.voiceMinutesMax]
    );
  }

  async checkGuildQuota(
    guildId: string,
    usageType: 'text_tokens' | 'images' | 'voice_minutes',
    amount: number
  ): Promise<{ allowed: boolean; remaining: number; max: number }> {
    // Get quota limit for this guild
    const quotaResult = await this.pool.query(
      `SELECT 
        CASE $2
          WHEN 'text_tokens' THEN COALESCE(daily_text_tokens, 50000)
          WHEN 'images' THEN COALESCE(daily_images, 5)
          WHEN 'voice_minutes' THEN COALESCE(daily_voice_minutes, 15)
        END as quota_limit
      FROM guild_quotas WHERE guild_id = $1`,
      [guildId, usageType]
    );

    const quotaLimit =
      quotaResult.rows[0]?.quota_limit ||
      (usageType === 'text_tokens' ? 50000 : usageType === 'images' ? 5 : 15);

    // Get current usage for today
    const usageResult = await this.pool.query(
      `SELECT 
        CASE $2
          WHEN 'text_tokens' THEN COALESCE(total_text_tokens, 0)
          WHEN 'images' THEN COALESCE(total_images, 0)
          WHEN 'voice_minutes' THEN COALESCE(total_voice_minutes, 0)
        END as current_usage
      FROM guild_daily_usage 
      WHERE guild_id = $1 AND usage_date = CURRENT_DATE`,
      [guildId, usageType]
    );

    const currentUsage = usageResult.rows[0]?.current_usage || 0;
    const remaining = Math.max(0, quotaLimit - currentUsage);
    const allowed = currentUsage + amount <= quotaLimit;

    return {
      allowed,
      remaining,
      max: quotaLimit
    };
  }

  async incrementUsage(
    guildId: string,
    userId: string,
    usageType: 'text_tokens' | 'images' | 'voice_minutes',
    amount: number
  ): Promise<boolean> {
    const result = await this.pool.query('SELECT increment_usage($1, $2, $3, $4) as success', [
      guildId,
      userId,
      usageType,
      amount
    ]);

    return result.rows[0]?.success ?? false;
  }

  async getGuildDailyUsage(guildId: string): Promise<{
    textTokens: number;
    images: number;
    voiceMinutes: number;
    date: Date;
  } | null> {
    const result = await this.pool.query(
      `SELECT * FROM guild_daily_usage 
       WHERE guild_id = $1 AND usage_date = CURRENT_DATE`,
      [guildId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      textTokens: row.total_text_tokens || 0,
      images: row.total_images || 0,
      voiceMinutes: row.total_voice_minutes || 0,
      date: new Date(row.usage_date)
    };
  }

  async getUserDailyUsage(
    guildId: string,
    userId: string
  ): Promise<{
    textTokens: number;
    images: number;
    voiceMinutes: number;
  } | null> {
    const result = await this.pool.query(
      `SELECT 
         COALESCE(text_tokens_used, 0) as text_tokens,
         COALESCE(images_used, 0) as images,
         COALESCE(voice_minutes_used, 0) as voice_minutes
       FROM usage_tracking
       WHERE guild_id = $1 AND user_id = $2 AND usage_date = CURRENT_DATE`,
      [guildId, userId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      textTokens: parseInt(row.text_tokens) || 0,
      images: parseInt(row.images) || 0,
      voiceMinutes: parseInt(row.voice_minutes) || 0
    };
  }

  async getGuildQuotaLimits(guildId: string): Promise<{
    textTokens: number;
    images: number;
    voiceMinutes: number;
  }> {
    const result = await this.pool.query(
      `SELECT 
         COALESCE(daily_text_tokens, 50000) as text_tokens,
         COALESCE(daily_images, 5) as images,
         COALESCE(daily_voice_minutes, 15) as voice_minutes
       FROM guild_quotas
       WHERE guild_id = $1`,
      [guildId]
    );

    if (result.rows.length === 0) {
      return {
        textTokens: 50000,
        images: 5,
        voiceMinutes: 15
      };
    }

    const row = result.rows[0];
    return {
      textTokens: parseInt(row.text_tokens) || 50000,
      images: parseInt(row.images) || 5,
      voiceMinutes: parseInt(row.voice_minutes) || 15
    };
  }

  // ============================================================================
  // NEW: Role Tier Quota Methods (database-driven quotas)
  // ============================================================================

  /**
   * Get quota limits for a role tier (guild-specific or global fallback)
   */
  async getRoleTierQuota(
    guildId: string,
    roleTier: 'admin' | 'moderator' | 'trusted' | 'member' | 'restricted'
  ): Promise<{ textTokens: number; images: number; voiceMinutes: number }> {
    // Use the SQL function for proper fallback logic
    const result = await this.pool.query(`SELECT * FROM get_role_tier_quota($1, $2)`, [
      guildId,
      roleTier
    ]);

    if (result.rows.length === 0) {
      // Fallback to hardcoded defaults if no database entries exist
      const defaults: Record<string, { textTokens: number; images: number; voiceMinutes: number }> =
      {
        admin: { textTokens: 50000, images: 5, voiceMinutes: 15 },
        moderator: { textTokens: 20000, images: 3, voiceMinutes: 10 },
        trusted: { textTokens: 10000, images: 2, voiceMinutes: 5 },
        member: { textTokens: 5000, images: 1, voiceMinutes: 0 },
        restricted: { textTokens: 0, images: 0, voiceMinutes: 0 }
      };
      const defaultMember = { textTokens: 5000, images: 1, voiceMinutes: 0 };
      return defaults[roleTier] ?? defaultMember;
    }

    const row = result.rows[0];
    return {
      textTokens: row.text_tokens ?? 0,
      images: row.images ?? 0,
      voiceMinutes: row.voice_minutes ?? 0
    };
  }

  /**
   * Atomic increment usage with race-condition protection
   * Returns success status, new total, and remaining quota
   */
  async atomicIncrementUsage(
    guildId: string,
    userId: string,
    usageType: 'text_tokens' | 'images' | 'voice_minutes',
    amount: number,
    userLimit: number
  ): Promise<{ success: boolean; newTotal: number; remaining: number }> {
    const result = await this.pool.query(
      `SELECT * FROM increment_usage_atomic($1, $2, $3, $4, $5)`,
      [guildId, userId, usageType, amount, userLimit]
    );

    if (result.rows.length === 0) {
      return { success: false, newTotal: 0, remaining: 0 };
    }

    const row = result.rows[0];
    return {
      success: row.success ?? false,
      newTotal: row.new_total ?? 0,
      remaining: row.remaining ?? 0
    };
  }

  /**
   * Log quota accuracy for estimate tuning (7-day rolling analysis)
   */
  async logQuotaAccuracy(
    guildId: string,
    userId: string,
    inputLength: number,
    estimatedTokens: number,
    actualTokens: number
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO quota_accuracy_log (guild_id, user_id, input_length, estimated_tokens, actual_tokens)
         VALUES ($1, $2, $3, $4, $5)`,
        [guildId, userId, inputLength, estimatedTokens, actualTokens]
      );
    } catch (error) {
      logger.warn('Failed to log quota accuracy:', error);
    }
  }

  /**
   * Get accuracy stats for estimate tuning (7-day rolling average)
   */
  async getQuotaAccuracyStats(days: number = 7): Promise<{
    avgRatio: number | null;
    sampleCount: number;
    stdDev: number | null;
  }> {
    const result = await this.pool.query(`SELECT * FROM get_accuracy_stats($1)`, [days]);

    if (result.rows.length === 0) {
      return { avgRatio: null, sampleCount: 0, stdDev: null };
    }

    const row = result.rows[0];
    return {
      avgRatio: row.avg_ratio ? parseFloat(row.avg_ratio) : null,
      sampleCount: parseInt(row.sample_count) || 0,
      stdDev: row.std_dev ? parseFloat(row.std_dev) : null
    };
  }

  /**
   * Mark a user for reset notification (called when quota is exhausted)
   */
  async markUserForResetNotification(
    guildId: string,
    userId: string,
    channelId: string
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO quota_reset_notifications (guild_id, user_id, channel_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
           channel_id = EXCLUDED.channel_id,
           exhausted_at = NOW()`,
        [guildId, userId, channelId]
      );
    } catch (error) {
      logger.warn('Failed to mark user for reset notification:', error);
    }
  }

  /**
   * Get users needing reset notification (quota has reset since exhaustion)
   */
  async getUsersNeedingResetNotification(): Promise<
    Array<{
      guildId: string;
      userId: string;
      channelId: string;
      exhaustedAt: Date;
    }>
  > {
    const result = await this.pool.query(`SELECT * FROM get_users_needing_reset_notification()`);

    return result.rows.map(
      (row: { guild_id: string; user_id: string; channel_id: string; exhausted_at: string }) => ({
        guildId: row.guild_id,
        userId: row.user_id,
        channelId: row.channel_id,
        exhaustedAt: new Date(row.exhausted_at)
      })
    );
  }

  /**
   * Clear reset notification after it's been sent
   */
  async clearResetNotification(guildId: string, userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM quota_reset_notifications WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );
  }

  /**
   * Get guild quota stats for admin view
   */
  async getGuildQuotaStats(guildId: string): Promise<{
    textTokensUsed: number;
    imagesUsed: number;
    voiceMinutesUsed: number;
    uniqueUsers: number;
    pendingResetNotifications: number;
  }> {
    const result = await this.pool.query(`SELECT * FROM get_guild_quota_stats($1)`, [guildId]);

    if (result.rows.length === 0) {
      return {
        textTokensUsed: 0,
        imagesUsed: 0,
        voiceMinutesUsed: 0,
        uniqueUsers: 0,
        pendingResetNotifications: 0
      };
    }

    const row = result.rows[0];
    return {
      textTokensUsed: parseInt(row.text_tokens_used) || 0,
      imagesUsed: parseInt(row.images_used) || 0,
      voiceMinutesUsed: parseInt(row.voice_minutes_used) || 0,
      uniqueUsers: parseInt(row.unique_users) || 0,
      pendingResetNotifications: parseInt(row.pending_reset_notifications) || 0
    };
  }

  /**
   * Cleanup old accuracy logs (>30 days) and usage data (>90 days)
   */
  async cleanupOldData(): Promise<{
    accuracyLogsDeleted: number;
    usageDeleted: number;
    guildUsageDeleted: number;
  }> {
    // Cleanup accuracy logs
    const accuracyResult = await this.pool.query(`SELECT cleanup_old_accuracy_logs(30) as deleted`);
    const accuracyLogsDeleted = accuracyResult.rows[0]?.deleted ?? 0;

    // Cleanup usage data
    const usageResult = await this.pool.query(`SELECT * FROM cleanup_old_usage(90)`);
    const usageRow = usageResult.rows[0] ?? {};

    return {
      accuracyLogsDeleted,
      usageDeleted: usageRow.usage_deleted ?? 0,
      guildUsageDeleted: usageRow.guild_usage_deleted ?? 0
    };
  }

  /**
   * Verify quota data integrity on startup
   */
  async verifyQuotaDataIntegrity(): Promise<void> {
    // Check for guilds with NULL quota values
    const nullQuotas = await this.pool.query(
      `SELECT guild_id FROM guild_quotas 
       WHERE daily_text_tokens IS NULL 
          OR daily_images IS NULL 
          OR daily_voice_minutes IS NULL`
    );

    if (nullQuotas.rows.length > 0) {
      logger.warn(`Found ${nullQuotas.rows.length} guilds with NULL quota values`);
    }

    // Check that global role tier quotas exist
    const globalQuotas = await this.pool.query(
      `SELECT role_tier FROM role_tier_quotas WHERE guild_id IS NULL`
    );

    const expectedTiers = ['admin', 'moderator', 'trusted', 'member', 'restricted'];
    const existingTiers = globalQuotas.rows.map((r: { role_tier: string }) => r.role_tier);
    const missingTiers = expectedTiers.filter(t => !existingTiers.includes(t));

    if (missingTiers.length > 0) {
      logger.warn(`Missing global role tier quotas for: ${missingTiers.join(', ')}`);
    }

    logger.info('Quota data integrity check completed');
  }
}
