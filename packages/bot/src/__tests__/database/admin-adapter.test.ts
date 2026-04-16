/**
 * Tests for AdminAdapter cost helpers
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { createMockPool } from '@silo/core/test-setup';
import { AdminAdapter } from '../../database/admin-adapter';

describe('AdminAdapter cost helpers', () => {
  let pool: ReturnType<typeof createMockPool>;
  let adapter: AdminAdapter;

  beforeEach(() => {
    pool = createMockPool();
    adapter = new AdminAdapter(pool as any);
  });

  test('calculateEventCost totals token, image, and voice pricing', async () => {
    pool._setQueryResults([
      {
        rows: [
          {
            input_cost_per_1k: 0.01,
            output_cost_per_1k: 0.02,
            image_cost: 0.1,
            voice_cost_per_minute: 0.05
          }
        ],
        rowCount: 1
      }
    ]);

    const cost = await adapter.calculateEventCost({
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      images: 2,
      voiceMinutes: 3
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0]?.[1]).toEqual(['openai', 'gpt-4o']);
    expect(cost).toBeCloseTo(0.37); // 0.01 + 0.01 + 0.2 + 0.15
  });

  test('logEvent stores estimated cost derived from pricing', async () => {
    pool._setQueryResults([
      {
        rows: [
          {
            input_cost_per_1k: 0.002,
            output_cost_per_1k: 0.004,
            image_cost: 0,
            voice_cost_per_minute: 0.05
          }
        ],
        rowCount: 1
      },
      { rows: [], rowCount: 1 }
    ]);

    const event = {
      guildId: 'guild1',
      userId: 'user1',
      eventType: 'command_used',
      command: 'speak',
      provider: 'openai',
      model: 'gpt-mini',
      inputTokens: 1000,
      outputTokens: 2000,
      tokensUsed: 2000,
      durationMs: 120000,
      success: true,
      metadata: null
    } as const;

    await adapter.logEvent(event as any);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const insertCall = pool.query.mock.calls[1]?.[1] as any[] | undefined;
    expect(insertCall).toBeDefined();

    // Parameters: guildId, userId, eventType, command, provider, model, inputTokens, outputTokens, ...
    expect(insertCall?.[0]).toBe('guild1'); // guildId
    expect(insertCall?.[6]).toBe(1000); // inputTokens
    expect(insertCall?.[7]).toBe(2000); // outputTokens
    expect(insertCall?.[10]).toBe(120000); // duration_ms
    expect(insertCall?.[13]).toBeCloseTo(0.11); // estimated_cost_usd (0.002 + 0.008 + 0.1)
  });

  test('getGuildCostAggregate uses duration_ms for voice minute aggregation', async () => {
    pool._setQueryResults([
      {
        rows: [
          {
            input_tokens: 0,
            output_tokens: 0,
            images: 0,
            total_cost: 0,
            text_cost: 0,
            image_cost: 0,
            voice_cost: 0,
            voice_minutes: 0,
            provider_breakdown: {}
          }
        ],
        rowCount: 1
      }
    ]);

    await adapter.getGuildCostAggregate('guild-1');

    const sql = (pool.query.mock.calls[0]?.[0] || '') as string;
    expect(sql).toContain('duration_ms');
    expect(sql).not.toContain('response_time_ms');
  });

  test('updateSafetyFeatures writes atomic JSONB merge update', async () => {
    pool._setQueryResults([
      {
        rows: [
          {
            guild_id: 'guild-1',
            default_provider: null,
            auto_thread: false,
            memory_retention_days: 30,
            rate_limit_multiplier: 1,
            features_enabled: {
              edgyModeEnabled: true,
              deterministicSentimentReviewEnabled: false
            },
            channel_configs: {},
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z')
          }
        ],
        rowCount: 1
      }
    ]);

    const result = await adapter.updateSafetyFeatures('guild-1', {
      edgyModeEnabled: true,
      deterministicSentimentReviewEnabled: false
    });

    const sql = (pool.query.mock.calls[0]?.[0] || '') as string;
    const params = (pool.query.mock.calls[0]?.[1] || []) as unknown[];
    expect(sql).toContain(
      "features_enabled = COALESCE(server_config.features_enabled, '{}'::jsonb)"
    );
    expect(params).toEqual(['guild-1', true, false]);
    expect(result.featuresEnabled.edgyModeEnabled).toBe(true);
    expect(result.featuresEnabled.deterministicSentimentReviewEnabled).toBe(false);
  });

  test('updateSafetyFeatures sends null deterministic when omitted', async () => {
    pool._setQueryResults([
      {
        rows: [
          {
            guild_id: 'guild-1',
            default_provider: null,
            auto_thread: false,
            memory_retention_days: 30,
            rate_limit_multiplier: 1,
            features_enabled: {
              edgyModeEnabled: false,
              deterministicSentimentReviewEnabled: false
            },
            channel_configs: {},
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z')
          }
        ],
        rowCount: 1
      }
    ]);

    await adapter.updateSafetyFeatures('guild-1', {
      edgyModeEnabled: false
    });

    const params = (pool.query.mock.calls[0]?.[1] || []) as unknown[];
    expect(params).toEqual(['guild-1', false, null]);
  });
});
