/**
 * Tests for CostAggregator scheduling and aggregation
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CostAggregator } from '../../services/cost-aggregator';

describe('CostAggregator', () => {
  let pool: { query: ReturnType<typeof mock> };
  let adminDb: any;

  beforeEach(() => {
    pool = {
      query: mock(async () => ({ rows: [{ guild_id: 'g1' }, { guild_id: 'g2' }], rowCount: 2 }))
    };

    adminDb = {
      upsertGuildCostSummary: mock(async () => {}),
      pool
    };
  });

  test('start aggregates immediately and schedules interval', async () => {
    const aggregator = new CostAggregator(adminDb as any);

    aggregator.start(50);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(adminDb.upsertGuildCostSummary).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenCalledTimes(1);

    // Ensure interval is set
    expect((aggregator as any).interval).not.toBeNull();

    aggregator.stop();
    expect((aggregator as any).interval).toBeNull();
  });

  test('start is idempotent and does not double schedule', async () => {
    const aggregator = new CostAggregator(adminDb as any);

    aggregator.start(1000);
    const firstInterval = (aggregator as any).interval;

    aggregator.start(1000);
    const secondInterval = (aggregator as any).interval;

    expect(firstInterval).toBe(secondInterval);

    aggregator.stop();
  });
});
