/**
 * Content Sanitizer
 *
 * Handles content moderation using OpenAI's moderation API and SHA256 hashing
 * for privacy-preserving logging. Never stores raw blocked content.
 */

import { createHash } from 'crypto';
import OpenAI from 'openai';
import { Pool } from 'pg';
import { logger } from '@silo/core';

// Lazy-initialized OpenAI client (avoids error at module load time)
let openai: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openai) {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }
  return openai;
}

export type ContentType = 'prompt' | 'memory' | 'feedback' | 'message';
export type ModerationAction = 'allowed' | 'blocked' | 'warned';

export interface ModerationResult {
  allowed: boolean;
  action: ModerationAction;
  flaggedCategories: string[];
  scores: Record<string, number>;
  contentHash: string;
}

export interface ModerationLogEntry {
  guildId: string;
  userId: string;
  contentType: ContentType;
  contentHash: string;
  contentLength: number;
  flaggedCategories: string[];
  moderationScores: Record<string, number>;
  actionTaken: ModerationAction;
}

// Categories that should result in blocking
const BLOCK_CATEGORIES = [
  'sexual/minors',
  'hate/threatening',
  'violence/graphic',
  'self-harm/intent',
  'self-harm/instructions'
];

// Categories that should result in warnings (not blocking)
const WARN_CATEGORIES = [
  'sexual',
  'hate',
  'violence',
  'self-harm',
  'harassment',
  'harassment/threatening'
];

// Threshold for category scores to trigger action (0.0 - 1.0)
const SCORE_THRESHOLD = 0.7;

class ContentSanitizer {
  private pool: Pool | null = null;

  /**
   * Initialize with database pool
   */
  init(pool: Pool): void {
    this.pool = pool;
  }

  /**
   * Generate SHA256 hash of content
   */
  hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Execute a query
   */
  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.pool) {
      throw new Error('ContentSanitizer not initialized - call init() first');
    }
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Moderate content using OpenAI's moderation API
   */
  async moderateContent(
    content: string,
    guildId: string,
    userId: string,
    contentType: ContentType
  ): Promise<ModerationResult> {
    const contentHash = this.hashContent(content);

    try {
      // Call OpenAI moderation API
      const response = await getOpenAIClient().moderations.create({
        model: 'omni-moderation-latest',
        input: content
      });

      const result = response.results[0];
      if (!result) {
        throw new Error('No moderation result returned');
      }

      const scores: Record<string, number> = {};
      const flaggedCategories: string[] = [];

      // Extract scores and flagged categories
      for (const [category, score] of Object.entries(result.category_scores)) {
        scores[category] = score as number;
        if (result.categories[category as keyof typeof result.categories]) {
          flaggedCategories.push(category);
        }
      }

      // Determine action based on flagged categories
      let action: ModerationAction = 'allowed';
      let allowed = true;

      // Check for block-worthy categories - ONLY block for severe categories
      // Regular violence, harassment etc should warn, not block (allows casual speech like "punch my friends")
      const shouldBlock = flaggedCategories.some(
        cat => BLOCK_CATEGORIES.includes(cat) && scores[cat] && scores[cat] >= SCORE_THRESHOLD
      );

      if (shouldBlock) {
        action = 'blocked';
        allowed = false;
      } else if (flaggedCategories.length > 0) {
        // Check for warning-worthy categories
        const shouldWarn = flaggedCategories.some(
          cat =>
            WARN_CATEGORIES.includes(cat) && scores[cat] && scores[cat] >= SCORE_THRESHOLD * 0.8
        );

        if (shouldWarn) {
          action = 'warned';
          allowed = true; // Warnings still allow the content through
        }
      }

      // Log the moderation result (using hash, never raw content)
      await this.logModerationResult({
        guildId,
        userId,
        contentType,
        contentHash,
        contentLength: content.length,
        flaggedCategories,
        moderationScores: scores,
        actionTaken: action
      });

      return {
        allowed,
        action,
        flaggedCategories,
        scores,
        contentHash
      };
    } catch (error) {
      logger.error('Content moderation failed:', error);

      // On API failure, allow content but log the failure
      await this.logModerationResult({
        guildId,
        userId,
        contentType,
        contentHash,
        contentLength: content.length,
        flaggedCategories: ['api_error'],
        moderationScores: {},
        actionTaken: 'allowed'
      });

      return {
        allowed: true,
        action: 'allowed',
        flaggedCategories: [],
        scores: {},
        contentHash
      };
    }
  }

  /**
   * Log moderation result to database
   */
  private async logModerationResult(entry: ModerationLogEntry): Promise<void> {
    try {
      await this.query(
        `INSERT INTO content_moderation_log 
                 (guild_id, user_id, content_type, content_hash, content_length, flagged_categories, moderation_scores, action_taken)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          entry.guildId,
          entry.userId,
          entry.contentType,
          entry.contentHash,
          entry.contentLength,
          entry.flaggedCategories,
          JSON.stringify(entry.moderationScores),
          entry.actionTaken
        ]
      );
    } catch (error) {
      logger.error('Failed to log moderation result:', error);
    }
  }

  /**
   * Check if a content hash was previously blocked
   * Useful for quick rejection of repeat offenders
   */
  async wasContentBlocked(contentHash: string): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      `SELECT EXISTS(
                SELECT 1 FROM content_moderation_log 
                WHERE content_hash = $1 AND action_taken = 'blocked'
            ) as exists`,
      [contentHash]
    );
    return result[0]?.exists ?? false;
  }

  /**
   * Quick check using hash before full moderation (performance optimization)
   */
  async quickCheck(
    content: string
  ): Promise<{ skip: boolean; hash: string; previousAction?: ModerationAction }> {
    const hash = this.hashContent(content);

    const result = await this.query<{ action_taken: ModerationAction }>(
      `SELECT action_taken FROM content_moderation_log 
             WHERE content_hash = $1 
             ORDER BY created_at DESC LIMIT 1`,
      [hash]
    );

    if (result[0]?.action_taken === 'blocked') {
      return { skip: true, hash, previousAction: 'blocked' };
    }

    return { skip: false, hash, previousAction: result[0]?.action_taken };
  }

  /**
   * Get moderation stats for a guild
   */
  async getGuildModerationStats(guildId: string): Promise<{
    totalChecks: number;
    blocked: number;
    warned: number;
    allowed: number;
    topFlaggedCategories: { category: string; count: number }[];
  }> {
    const counts = await this.query<{ action_taken: ModerationAction; count: string }>(
      `SELECT action_taken, COUNT(*) as count 
             FROM content_moderation_log 
             WHERE guild_id = $1 
             GROUP BY action_taken`,
      [guildId]
    );

    const stats = {
      totalChecks: 0,
      blocked: 0,
      warned: 0,
      allowed: 0,
      topFlaggedCategories: [] as { category: string; count: number }[]
    };

    for (const row of counts) {
      const count = parseInt(row.count);
      stats.totalChecks += count;
      if (row.action_taken === 'blocked') stats.blocked = count;
      else if (row.action_taken === 'warned') stats.warned = count;
      else stats.allowed = count;
    }

    // Get top flagged categories
    const categories = await this.query<{ category: string; count: string }>(
      `SELECT unnest(flagged_categories) as category, COUNT(*) as count
             FROM content_moderation_log
             WHERE guild_id = $1 AND array_length(flagged_categories, 1) > 0
             GROUP BY category
             ORDER BY count DESC
             LIMIT 5`,
      [guildId]
    );

    stats.topFlaggedCategories = categories.map(c => ({
      category: c.category,
      count: parseInt(c.count)
    }));

    return stats;
  }

  /**
   * Get user moderation history (for potential rate limiting or bans)
   */
  async getUserModerationHistory(
    userId: string,
    days: number = 30
  ): Promise<{
    blockedCount: number;
    warnedCount: number;
    recentBlocks: { contentType: ContentType; createdAt: Date }[];
  }> {
    const counts = await this.query<{ action_taken: ModerationAction; count: string }>(
      `SELECT action_taken, COUNT(*) as count 
             FROM content_moderation_log 
             WHERE user_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
             GROUP BY action_taken`,
      [userId]
    );

    const history = {
      blockedCount: 0,
      warnedCount: 0,
      recentBlocks: [] as { contentType: ContentType; createdAt: Date }[]
    };

    for (const row of counts) {
      if (row.action_taken === 'blocked') history.blockedCount = parseInt(row.count);
      else if (row.action_taken === 'warned') history.warnedCount = parseInt(row.count);
    }

    const recentBlocks = await this.query<{ content_type: ContentType; created_at: Date }>(
      `SELECT content_type, created_at
             FROM content_moderation_log
             WHERE user_id = $1 AND action_taken = 'blocked' AND created_at > NOW() - INTERVAL '${days} days'
             ORDER BY created_at DESC
             LIMIT 10`,
      [userId]
    );

    history.recentBlocks = recentBlocks.map(b => ({
      contentType: b.content_type,
      createdAt: b.created_at
    }));

    return history;
  }

  /**
   * Sanitize text by removing potential prompt injection patterns
   */
  sanitizePrompt(input: string): string {
    // Remove common injection patterns
    let sanitized = input;

    // Remove attempts to override system prompts
    const injectionPatterns = [
      /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
      /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|prompts?|rules?)/gi,
      /you\s+are\s+now\s+(a|an)\s+/gi,
      /system\s*:\s*/gi,
      /\[SYSTEM\]/gi,
      /###\s*(system|instruction|prompt)/gi,
      /disregard\s+(all\s+)?/gi,
      /override\s+(the\s+)?/gi,
      /pretend\s+(you're|you\s+are|to\s+be)\s+/gi
    ];

    for (const pattern of injectionPatterns) {
      sanitized = sanitized.replace(pattern, '[filtered]');
    }

    // Truncate extremely long inputs (potential buffer overflow attempts)
    const MAX_INPUT_LENGTH = 10000;
    if (sanitized.length > MAX_INPUT_LENGTH) {
      sanitized = sanitized.slice(0, MAX_INPUT_LENGTH) + '... [truncated]';
    }

    return sanitized;
  }

  /**
   * Full content processing pipeline
   */
  async processContent(
    content: string,
    guildId: string,
    userId: string,
    contentType: ContentType
  ): Promise<{
    processedContent: string;
    moderation: ModerationResult;
  }> {
    // Sanitize first
    const sanitized = this.sanitizePrompt(content);

    // Quick check for previously blocked content
    const quickResult = await this.quickCheck(sanitized);
    if (quickResult.skip && quickResult.previousAction === 'blocked') {
      return {
        processedContent: '',
        moderation: {
          allowed: false,
          action: 'blocked',
          flaggedCategories: ['previously_blocked'],
          scores: {},
          contentHash: quickResult.hash
        }
      };
    }

    // Full moderation check
    const moderation = await this.moderateContent(sanitized, guildId, userId, contentType);

    return {
      processedContent: moderation.allowed ? sanitized : '',
      moderation
    };
  }
}

// Export singleton instance
export const contentSanitizer = new ContentSanitizer();
