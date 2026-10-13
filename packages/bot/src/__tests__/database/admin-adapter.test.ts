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

  test.each([false, true])(
    'redacts URL events before persistence (legacy schema: %s)',
    async legacy => {
      if (legacy) pool.query.mockRejectedValueOnce({ code: '42703' });
      const target = new URL(
        'https://example.com/private-key?signature=query-secret#fragment-secret'
      );
      target.username = 'user-secret';
      target.password = 'password-secret';
      await adapter.logUrlSecurityEvent({
        guildId: 'guild-a',
        userId: 'user-a',
        action: 'blocked',
        reason: 'redirect_response_blocked',
        domain: 'example.com',
        url: target.toString(),
        metadata: {
          location: '../other-key?signature=redirect-secret#fragment-secret',
          contentLength: 42
        }
      });
      expect(pool.query).toHaveBeenCalledTimes(legacy ? 2 : 1);
      for (const call of pool.query.mock.calls) {
        const values = call[1] as unknown[];
        expect(values[3]).toBe('https://example.com');
        const metadata = JSON.parse(values.at(-1) as string);
        expect(metadata.location).toBe('https://example.com');
        expect(metadata.contentLength).toBe(42);
        const recorded = JSON.stringify(values);
        for (const secret of [
          'user-secret',
          'password-secret',
          'private-key',
          'query-secret',
          'fragment-secret',
          'other-key',
          'redirect-secret'
        ])
          expect(recorded).not.toContain(secret);
      }
    }
  );

  test('invalid URL events never retain raw credential-like strings', async () => {
    await adapter.logUrlSecurityEvent({
      guildId: 'guild-a',
      userId: 'user-a',
      domain: '',
      action: 'blocked',
      reason: 'invalid_url',
      url: 'not-a-url-password-secret',
      metadata: { location: 'invalid-redirect-secret' }
    });
    const recorded = JSON.stringify(pool.query.mock.calls);
    expect(recorded).not.toContain('password-secret');
    expect(recorded).not.toContain('redirect-secret');
  });

  test('feedback preserves message and optional context in the existing schema', async () => {
    await adapter.submitFeedback({
      guildId: 'guild-a',
      userId: 'user-a',
      username: 'tester',
      feedbackType: 'general',
      content: "A user's feedback; SELECT 1;",
      context: 'Additional context'
    });
    const [sql, values] = pool.query.mock.calls[0]!;
    expect(sql).toContain('(guild_id, user_id, feedback_type, message, metadata)');
    expect(sql).not.toContain("A user's feedback");
    expect(values).toEqual([
      'guild-a',
      'user-a',
      'general',
      "A user's feedback; SELECT 1;",
      JSON.stringify({ username: 'tester', context: 'Additional context' })
    ]);
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

  test('getServerRuntimeConfig returns config and prompt state from one query', async () => {
    pool._setQueryResults([
      {
        rows: [
          {
            guild_id: 'guild-1',
            default_provider: 'xai',
            auto_thread: true,
            memory_retention_days: 14,
            rate_limit_multiplier: 1,
            features_enabled: { edgyModeEnabled: false },
            channel_configs: {},
            system_prompt: 'Respond like a Roman emperor.',
            voice_system_prompt: 'Speak like a Roman emperor.',
            system_prompt_enabled: false,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z')
          }
        ],
        rowCount: 1
      }
    ]);

    const result = await adapter.getServerRuntimeConfig('guild-1');

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(result.serverConfig?.defaultProvider).toBe('xai');
    expect(result.systemPrompt).toEqual({
      prompt: 'Respond like a Roman emperor.',
      enabled: false
    });
  });
});
