/**
 * Inactivity Scheduler
 *
 * Runs daily to check for inactive guilds (25-29 days) to send warnings,
 * and guilds at 30+ days to evict. Also handles data cleanup for
 * guilds that have been deactivated for 30+ days.
 */

import { Pool } from 'pg';
import { Client } from 'discord.js';
import { logger } from '@silo/core';
import { guildManager } from './guild-manager';
import { deploymentDetector } from './deployment';

interface InactiveGuild {
  guild_id: string;
  guild_name: string;
  warning_channel_id: string | null;
  days_inactive: number;
  owner_id: string;
}

interface GuildToEvict {
  guild_id: string;
  guild_name: string;
  warning_channel_id: string | null;
  owner_id: string;
  days_inactive: number;
}

interface GuildToDelete {
  guild_id: string;
  guild_name: string;
  deactivated_at: Date;
}

class InactivityScheduler {
  private pool: Pool | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  // Run interval: 1 hour (checks will no-op if already processed today)
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  /**
   * Initialize with database pool and Discord client
   */
  init(pool: Pool, client: Client): void {
    this.pool = pool;

    // Initialize guild manager with same pool and client
    guildManager.init(pool, client);
  }

  /**
   * Execute a query
   */
  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.pool) {
      throw new Error('InactivityScheduler not initialized - call init() first');
    }
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Inactivity scheduler already running');
      return;
    }

    // Only run in hosted mode
    const config = deploymentDetector.getConfig();
    if (config.isSelfHosted) {
      logger.info('Inactivity scheduler disabled in self-hosted mode');
      return;
    }

    this.isRunning = true;
    logger.info('Starting inactivity scheduler');

    // Run immediately on start
    this.runScheduledTasks().catch(err => {
      logger.error('Initial inactivity check failed:', err);
    });

    // Then run every hour
    this.intervalId = setInterval(() => {
      this.runScheduledTasks().catch(err => {
        logger.error('Scheduled inactivity check failed:', err);
      });
    }, this.CHECK_INTERVAL_MS);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('Inactivity scheduler stopped');
  }

  /**
   * Run all scheduled tasks
   */
  async runScheduledTasks(): Promise<void> {
    logger.info('Running inactivity scheduled tasks...');

    try {
      // 1. Send warnings to inactive guilds (25-29 days)
      await this.processInactiveWarnings();

      // 2. Evict guilds at 30+ days
      await this.processEvictions();

      // 3. Expire old waitlist notifications
      await this.processWaitlistExpirations();

      // 4. Delete data for guilds 30 days after deactivation
      await this.processDataDeletions();

      logger.info('Inactivity scheduled tasks completed');
    } catch (error) {
      logger.error('Error running scheduled tasks:', error);
      throw error;
    }
  }

  /**
   * Send warnings to guilds that have been inactive for 25-29 days
   */
  async processInactiveWarnings(): Promise<{ sent: number; failed: number }> {
    const guilds = await this.query<InactiveGuild>(`SELECT * FROM get_guilds_needing_warning()`);

    let sent = 0;
    let failed = 0;

    for (const guild of guilds) {
      try {
        const success = await guildManager.sendInactivityWarning(
          guild.guild_id,
          guild.days_inactive,
          guild.warning_channel_id
        );

        if (success) {
          sent++;
          logger.info(
            `Sent inactivity warning to ${guild.guild_name} (${guild.days_inactive} days)`
          );
        } else {
          failed++;
          logger.warn(`Failed to send warning to ${guild.guild_name}`);
        }
      } catch (error) {
        failed++;
        logger.error(`Error sending warning to ${guild.guild_name}:`, error);
      }
    }

    if (sent > 0 || failed > 0) {
      logger.info(`Inactivity warnings: ${sent} sent, ${failed} failed`);
    }

    return { sent, failed };
  }

  /**
   * Evict guilds that have been inactive for 30+ days
   */
  async processEvictions(): Promise<{ evicted: number; failed: number }> {
    const guilds = await this.query<GuildToEvict>(`SELECT * FROM get_guilds_to_evict()`);

    let evicted = 0;
    let failed = 0;

    for (const guild of guilds) {
      try {
        await guildManager.evictGuild(guild.guild_id, true);
        evicted++;
        logger.info(
          `Evicted guild ${guild.guild_name} after ${guild.days_inactive} days of inactivity`
        );
      } catch (error) {
        failed++;
        logger.error(`Error evicting guild ${guild.guild_name}:`, error);
      }
    }

    if (evicted > 0 || failed > 0) {
      logger.info(`Evictions: ${evicted} evicted, ${failed} failed`);
    }

    return { evicted, failed };
  }

  /**
   * Expire waitlist notifications that have passed their 48h window
   */
  async processWaitlistExpirations(): Promise<number> {
    const result = await this.query<{ expire_old_waitlist_notifications: number }>(
      `SELECT expire_old_waitlist_notifications()`
    );

    const expired = result[0]?.expire_old_waitlist_notifications ?? 0;

    if (expired > 0) {
      logger.info(`Expired ${expired} waitlist notifications`);

      // Promote the next guild(s) for each expired slot
      for (let i = 0; i < expired; i++) {
        await guildManager.promoteFromWaitlist();
      }
    }

    return expired;
  }

  /**
   * Delete data for guilds that have been deactivated for 30+ days
   */
  async processDataDeletions(): Promise<{ deleted: number; failed: number }> {
    const guilds = await this.query<GuildToDelete>(`SELECT * FROM get_guilds_for_data_deletion()`);

    let deleted = 0;
    let failed = 0;

    for (const guild of guilds) {
      try {
        await this.query(`SELECT delete_guild_data($1)`, [guild.guild_id]);
        deleted++;
        logger.info(
          `Deleted data for guild ${guild.guild_name} (deactivated: ${guild.deactivated_at})`
        );
      } catch (error) {
        failed++;
        logger.error(`Error deleting data for guild ${guild.guild_name}:`, error);
      }
    }

    if (deleted > 0 || failed > 0) {
      logger.info(`Data deletions: ${deleted} deleted, ${failed} failed`);
    }

    return { deleted, failed };
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    running: boolean;
    mode: string;
    nextRun: Date | null;
  } {
    const config = deploymentDetector.getConfig();

    return {
      running: this.isRunning,
      mode: config.mode,
      nextRun: this.isRunning ? new Date(Date.now() + this.CHECK_INTERVAL_MS) : null
    };
  }

  /**
   * Manually trigger a check (for admin commands)
   */
  async manualCheck(): Promise<{
    warnings: { sent: number; failed: number };
    evictions: { evicted: number; failed: number };
    waitlistExpirations: number;
    dataDeletions: { deleted: number; failed: number };
  }> {
    const warnings = await this.processInactiveWarnings();
    const evictions = await this.processEvictions();
    const waitlistExpirations = await this.processWaitlistExpirations();
    const dataDeletions = await this.processDataDeletions();

    return {
      warnings,
      evictions,
      waitlistExpirations,
      dataDeletions
    };
  }

  /**
   * Get upcoming warnings and evictions (for admin dashboard)
   */
  async getUpcomingActions(): Promise<{
    warningsToSend: InactiveGuild[];
    guildsToEvict: GuildToEvict[];
    guildsToDelete: GuildToDelete[];
  }> {
    const warningsToSend = await this.query<InactiveGuild>(
      `SELECT * FROM get_guilds_needing_warning()`
    );

    const guildsToEvict = await this.query<GuildToEvict>(`SELECT * FROM get_guilds_to_evict()`);

    const guildsToDelete = await this.query<GuildToDelete>(
      `SELECT * FROM get_guilds_for_data_deletion()`
    );

    return {
      warningsToSend,
      guildsToEvict,
      guildsToDelete
    };
  }
}

// Export singleton instance
export const inactivityScheduler = new InactivityScheduler();
