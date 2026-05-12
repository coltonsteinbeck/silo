import { Pool } from 'pg';
import { logger } from '@silo/core';
import { AdminAdapter } from '../database/admin-adapter';
import { withLangfuseRootTrace, withLangfuseSpan } from '../telemetry/langfuse-client';
import { buildLangfuseTags, buildLangfuseTraceMetadata } from '../telemetry/langfuse-metadata';

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

  private buildTraceContext(commandName: string): {
    metadata: Record<string, unknown>;
    tags: string[];
  } {
    const metadataInput = {
      messageType: 'scheduled-job' as const,
      commandName
    };

    return {
      metadata: buildLangfuseTraceMetadata(metadataInput),
      tags: buildLangfuseTags(metadataInput)
    };
  }

  start(intervalMs = 60 * 60 * 1000): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.aggregateAll('interval').catch(err => logger.error('Cost aggregation failed:', err));
    }, intervalMs);
    // Run immediately on start
    this.aggregateAll('startup').catch(err => logger.error('Cost aggregation failed:', err));
    logger.info(`CostAggregator started (interval ${intervalMs / 1000}s)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async aggregateAll(trigger: 'startup' | 'interval'): Promise<void> {
    const traceContext = this.buildTraceContext('cost-aggregation');

    await withLangfuseRootTrace(
      {
        name: 'system.cost-aggregation',
        traceName: 'system.cost-aggregation',
        sessionId: 'system:cost-aggregation',
        metadata: {
          ...traceContext.metadata,
          trigger
        },
        tags: traceContext.tags
      },
      async observation => {
        try {
          const guilds = await withLangfuseSpan(
            {
              name: 'cost-aggregation.fetch-active-guilds',
              metadata: {
                ...traceContext.metadata,
                trigger
              },
              tags: traceContext.tags
            },
            async () => this.getActiveGuilds()
          );

          let succeededGuilds = 0;
          const failedGuilds: string[] = [];

          for (const guildId of guilds) {
            const guildTraceContext = {
              metadata: buildLangfuseTraceMetadata({
                guildId,
                messageType: 'scheduled-job',
                commandName: 'cost-aggregation-guild'
              }),
              tags: buildLangfuseTags({
                guildId,
                messageType: 'scheduled-job',
                commandName: 'cost-aggregation-guild'
              })
            };

            try {
              await withLangfuseSpan(
                {
                  name: 'cost-aggregation.upsert-guild-summary',
                  metadata: {
                    ...guildTraceContext.metadata,
                    trigger
                  },
                  tags: guildTraceContext.tags
                },
                async span => {
                  await this.admin.upsertGuildCostSummary(guildId);
                  span?.update({
                    output: {
                      status: 'completed'
                    }
                  });
                }
              );
              succeededGuilds++;
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

          observation?.update({
            output: {
              status: 'completed',
              trigger,
              guildCount: guilds.length,
              succeededGuilds,
              failedGuildCount: failedGuilds.length,
              failedGuildIds: failedGuilds.slice(0, 20)
            }
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          observation?.update({
            level: 'ERROR',
            statusMessage: errorMessage,
            output: {
              status: 'failed',
              trigger,
              error: errorMessage
            }
          });
          throw error;
        }
      }
    );
  }

  private async getActiveGuilds(): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT DISTINCT guild_id FROM analytics_events WHERE created_at >= NOW() - INTERVAL '30 days'`
    );
    return res.rows.map(r => r.guild_id as string);
  }
}
