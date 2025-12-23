import { Pool } from 'pg';
import { logger } from '@silo/core';
import { AdminAdapter } from '../database/admin-adapter';

// Periodically aggregates 30-day costs per guild into guild_cost_summary
export class CostAggregator {
  private interval: ReturnType<typeof setInterval> | null = null;
  private admin: AdminAdapter;
  private pool: Pool;

  constructor(adminDb: AdminAdapter) {
    this.admin = adminDb;
    // AdminAdapter already owns a pool; tap into it
    // @ts-expect-error accessing private property intentionally for reuse
    this.pool = adminDb.pool;
  }

  start(intervalMs = 60 * 60 * 1000): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.aggregateAll().catch(err => logger.error('Cost aggregation failed:', err));
    }, intervalMs);
    // Run immediately on start
    this.aggregateAll().catch(err => logger.error('Cost aggregation failed:', err));
    logger.info(`CostAggregator started (interval ${intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async aggregateAll(): Promise<void> {
    const guilds = await this.getActiveGuilds();
    const failedGuilds: string[] = [];
    for (const guildId of guilds) {
      try {
        await this.admin.upsertGuildCostSummary(guildId);
      } catch (error) {
        logger.error(`Failed to aggregate costs for guild ${guildId}:`, error);
        failedGuilds.push(guildId);
      }
    }
    if (failedGuilds.length > 0) {
      logger.warn(
        `Cost aggregation failed for ${failedGuilds.length} guild(s): ${failedGuilds.join(', ')}`
      );
    }
  }

  private async getActiveGuilds(): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT DISTINCT guild_id FROM analytics_events WHERE created_at >= NOW() - INTERVAL '30 days'`
    );
    return res.rows.map(r => r.guild_id as string);
  }
}
