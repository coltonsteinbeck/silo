import { describe, expect, mock, test } from 'bun:test';
import type { ConversationTurn } from '@silo/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresAdapter } from '../../database/postgres';

type ConversationRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  user_id: string;
  discord_message_id: string | null;
  prompt_hash: string;
  role: 'user' | 'assistant';
  content: string;
  reply_to_message_id: string | null;
  reply_to_user_id: string | null;
  referenced_content: string | null;
  image_summary: string | null;
  turn_id: string;
  turn_sequence: 0 | 1;
  requester_user_id: string;
  prompt_eligible: boolean;
  safety_state: string;
  safety_categories: string[];
  created_at: string;
};

function conversationRow(overrides: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    guild_id: 'guild-1',
    channel_id: 'channel-1',
    user_id: 'requester-1',
    discord_message_id: 'discord-user-1',
    prompt_hash: 'prompt-hash-1',
    role: 'user',
    content: 'Hello',
    reply_to_message_id: null,
    reply_to_user_id: null,
    referenced_content: null,
    image_summary: null,
    turn_id: '00000000-0000-4000-8000-000000000010',
    turn_sequence: 0,
    requester_user_id: 'requester-1',
    prompt_eligible: true,
    safety_state: 'allowed',
    safety_categories: [],
    created_at: '2026-07-09T12:00:00.000Z',
    ...overrides
  };
}

function conversationTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    turnId: '00000000-0000-4000-8000-000000000010',
    requesterUserId: 'requester-1',
    promptEligible: true,
    safetyState: 'allowed',
    safetyCategories: [],
    userMessage: {
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'requester-1',
      discordMessageId: 'discord-user-1',
      promptHash: 'prompt-hash-1',
      role: 'user',
      content: 'Hello'
    },
    assistantMessage: {
      guildId: 'guild-1',
      channelId: 'channel-1',
      userId: 'assistant-1',
      discordMessageId: 'discord-assistant-1',
      promptHash: 'prompt-hash-1',
      role: 'assistant',
      content: 'Hi there'
    },
    ...overrides
  };
}

function adapterWithPool(pool: object): PostgresAdapter {
  const adapter = new PostgresAdapter('postgresql://user:pass@localhost:5432/test_db');
  Object.defineProperty(adapter, 'pool', { value: pool });
  return adapter;
}

describe('PostgresAdapter prompt context', () => {
  test('selects only complete eligible turns for the same guild, requester, and prompt', async () => {
    const rows = [
      conversationRow(),
      conversationRow({
        id: '00000000-0000-4000-8000-000000000002',
        user_id: 'assistant-1',
        discord_message_id: 'discord-assistant-1',
        role: 'assistant',
        content: 'Hi there',
        turn_sequence: 1
      })
    ];
    const query = mock(async () => ({
      rows: [
        {
          messages: rows,
          selected_turn_count: 1,
          excluded_turn_count: 0,
          exclusion_reasons: {}
        }
      ],
      rowCount: 1
    }));
    const adapter = adapterWithPool({ query });

    const result = await adapter.getPromptContext({
      guildId: 'guild-1',
      channelId: 'channel-1',
      promptHash: 'prompt-hash-1',
      requesterUserId: 'requester-1',
      maxTurns: 99,
      maxAgeMs: 1
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('WHERE message.guild_id = $1');
    expect(sql).toContain('AND message.requester_user_id = $4');
    expect(sql).toContain("COUNT(*) FILTER (WHERE turn_sequence = 0 AND role = 'user')");
    expect(sql).toContain("COUNT(*) FILTER (WHERE turn_sequence = 1 AND role = 'assistant')");
    expect(sql).toContain('WHEN row_count <> 2');
    expect(params).toEqual(['guild-1', 'channel-1', 'prompt-hash-1', 'requester-1', 60_000, 3]);
    expect(result.scope).toBe('same_user');
    expect(result.selectedTurnCount).toBe(1);
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  test('reports legacy, unsafe, incomplete, and over-limit same-user candidates', async () => {
    const selectedRows = [
      conversationRow(),
      conversationRow({
        id: '00000000-0000-4000-8000-000000000002',
        user_id: 'assistant-1',
        role: 'assistant',
        turn_sequence: 1
      })
    ];
    const exclusionReasons = {
      legacy: 2,
      unsafe_or_ineligible: 1,
      incomplete_or_unpaired: 1,
      over_limit: 2
    };
    const query = mock(async () => ({
      rows: [
        {
          messages: JSON.stringify(selectedRows),
          selected_turn_count: '1',
          excluded_turn_count: '6',
          exclusion_reasons: JSON.stringify(exclusionReasons)
        }
      ],
      rowCount: 1
    }));
    const adapter = adapterWithPool({ query });

    const result = await adapter.getPromptContext({
      guildId: 'guild-1',
      channelId: 'channel-1',
      promptHash: 'prompt-hash-1',
      requesterUserId: 'requester-1',
      maxTurns: 3,
      maxAgeMs: 30 * 60 * 1000
    });

    const [sql] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql).toContain("THEN 'legacy'");
    expect(sql).toContain("THEN 'incomplete_or_unpaired'");
    expect(sql).toContain("THEN 'unsafe_or_ineligible'");
    expect(sql).toContain("THEN 'over_limit'");
    expect(sql).toContain('jsonb_object_agg(exclusion_reason, reason_count)');
    expect(result.scope).toBe('same_user');
    expect(result.selectedTurnCount).toBe(1);
    expect(result.excludedTurnCount).toBe(6);
    expect(result.exclusionReasons).toEqual(exclusionReasons);
    expect(result.messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  test('walks an eligible direct-reply chain without restricting handoffs to one requester', async () => {
    const olderTurnId = '00000000-0000-4000-8000-000000000020';
    const newerTurnId = '00000000-0000-4000-8000-000000000030';
    const rows = [
      conversationRow({ turn_id: olderTurnId }),
      conversationRow({
        id: '00000000-0000-4000-8000-000000000021',
        turn_id: olderTurnId,
        user_id: 'assistant-1',
        role: 'assistant',
        turn_sequence: 1
      }),
      conversationRow({
        id: '00000000-0000-4000-8000-000000000030',
        turn_id: newerTurnId,
        user_id: 'requester-2',
        requester_user_id: 'requester-2',
        reply_to_message_id: 'discord-assistant-older'
      }),
      conversationRow({
        id: '00000000-0000-4000-8000-000000000031',
        turn_id: newerTurnId,
        user_id: 'assistant-1',
        requester_user_id: 'requester-2',
        role: 'assistant',
        turn_sequence: 1
      })
    ];
    const query = mock(async () => ({ rows, rowCount: rows.length }));
    const adapter = adapterWithPool({ query });

    const result = await adapter.getPromptContext({
      guildId: 'guild-1',
      channelId: 'channel-1',
      promptHash: 'prompt-hash-1',
      requesterUserId: 'requester-3',
      replyToMessageId: 'discord-assistant-newer',
      maxTurns: 2
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('WITH RECURSIVE eligible_turns AS');
    expect(sql).toContain('JOIN eligible_turns eligible ON eligible.turn_id = candidate.turn_id');
    expect(sql).toContain('JOIN conversation_messages current_user_message');
    expect(sql).not.toContain('JOIN conversation_messages current_user\n');
    expect(sql).not.toContain('requester_user_id = $');
    expect(params).toEqual(['discord-assistant-newer', 'guild-1', 'channel-1', 'prompt-hash-1', 2]);
    expect(result.scope).toBe('reply_chain');
    expect(result.selectedTurnCount).toBe(2);
    expect(result.excludedTurnCount).toBe(0);
    expect(result.exclusionReasons).toEqual({});
  });

  test('reports an ineligible stored ancestor that stops a reply chain before its limit', async () => {
    const rows = [
      conversationRow(),
      conversationRow({
        id: '00000000-0000-4000-8000-000000000002',
        user_id: 'assistant-1',
        role: 'assistant',
        turn_sequence: 1
      })
    ].map(row => ({
      ...row,
      reply_ancestor_excluded_count: 1,
      reply_ancestor_exclusion_reason: 'reply_ancestor_ineligible'
    }));
    const query = mock(async () => ({ rows, rowCount: rows.length }));
    const adapter = adapterWithPool({ query });

    const result = await adapter.getPromptContext({
      guildId: 'guild-1',
      channelId: 'channel-1',
      promptHash: 'prompt-hash-1',
      requesterUserId: 'requester-2',
      replyToMessageId: 'discord-assistant-1',
      maxTurns: 3
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('blocked_reply_ancestor AS');
    expect(sql).toContain('WHERE oldest.depth < $5');
    expect(sql).toContain('ON candidate.guild_id = $2');
    expect(sql).toContain('AND candidate.channel_id = $3');
    expect(sql).toContain('AND candidate.prompt_hash = $4');
    expect(sql).toContain('WHERE eligible.turn_id = candidate.turn_id');
    expect(sql).toContain("THEN 'reply_ancestor_ineligible'");
    expect(params).toEqual(['discord-assistant-1', 'guild-1', 'channel-1', 'prompt-hash-1', 3]);
    expect(result.scope).toBe('reply_chain');
    expect(result.selectedTurnCount).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.excludedTurnCount).toBe(1);
    expect(result.exclusionReasons).toEqual({ reply_ancestor_ineligible: 1 });
  });

  test('does not fall back to free-floating history when a reply target is ineligible', async () => {
    const query = mock(async () => ({ rows: [], rowCount: 0 }));
    const adapter = adapterWithPool({ query });

    const result = await adapter.getPromptContext({
      guildId: 'guild-1',
      channelId: 'channel-1',
      promptHash: 'prompt-hash-1',
      requesterUserId: 'requester-1',
      replyToMessageId: 'legacy-or-blocked-message'
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      messages: [],
      scope: 'none',
      selectedTurnCount: 0,
      excludedTurnCount: 1,
      exclusionReasons: { reply_target_ineligible: 1 }
    });
  });
});

describe('PostgresAdapter storeConversationTurn', () => {
  test('stores user then assistant atomically with explicit sequence and one transaction timestamp', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: mock(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (!sql.includes('INSERT INTO conversation_messages')) {
          return { rows: [], rowCount: 0 };
        }

        const sequence = params?.[12] as 0 | 1;
        const role = params?.[5] as 'user' | 'assistant';
        return {
          rows: [
            conversationRow({
              id:
                sequence === 0
                  ? '00000000-0000-4000-8000-000000000001'
                  : '00000000-0000-4000-8000-000000000002',
              user_id: params?.[2] as string,
              discord_message_id: params?.[3] as string,
              role,
              content: params?.[6] as string,
              turn_sequence: sequence
            })
          ],
          rowCount: 1
        };
      }),
      release: mock(() => {})
    };
    const connect = mock(async () => client);
    const adapter = adapterWithPool({ connect });

    const stored = await adapter.storeConversationTurn(conversationTurn());

    expect(calls.map(call => call.sql.trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'INSERT',
      'INSERT',
      'COMMIT'
    ]);
    const inserts = calls.filter(call => call.sql.includes('INSERT INTO conversation_messages'));
    expect(inserts.map(call => call.params?.[5])).toEqual(['user', 'assistant']);
    expect(inserts.map(call => call.params?.[12])).toEqual([0, 1]);
    expect(inserts.every(call => call.sql.includes('transaction_timestamp()'))).toBe(true);
    expect(stored.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back both rows when the assistant insert fails', async () => {
    let insertCount = 0;
    const client = {
      query: mock(async (sql: string) => {
        if (sql.includes('INSERT INTO conversation_messages')) {
          insertCount += 1;
          if (insertCount === 2) {
            throw new Error('assistant insert failed');
          }
          return { rows: [conversationRow()], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: mock(() => {})
    };
    const adapter = adapterWithPool({ connect: mock(async () => client) });

    await expect(adapter.storeConversationTurn(conversationTurn())).rejects.toThrow(
      'assistant insert failed'
    );

    expect(client.query.mock.calls.some(call => call[0] === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('rejects unsafe eligible state before opening a transaction', async () => {
    const connect = mock(async () => {
      throw new Error('should not connect');
    });
    const adapter = adapterWithPool({ connect });

    await expect(
      adapter.storeConversationTurn(
        conversationTurn({ promptEligible: true, safetyState: 'blocked' })
      )
    ).rejects.toThrow('is not prompt eligible');
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('conversation turn integrity migration', () => {
  test('quarantines legacy rows and constrains new eligible turns without deleting audit data', () => {
    const migration = readFileSync(
      resolve(
        import.meta.dir,
        '../../../../../supabase/migrations/025_conversation_turn_integrity.sql'
      ),
      'utf8'
    );

    expect(migration).toContain('prompt_eligible BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain("safety_state TEXT NOT NULL DEFAULT 'legacy'");
    expect(migration).toContain("safety_categories JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(migration).toContain('conversation_messages_turn_metadata_check');
    expect(migration).toContain(
      "safety_state IN ('allowed', 'output_repaired', 'quality_repaired')"
    );
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_sequence');
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS idx_conversation_prompt_context_candidates'
    );
    expect(migration).not.toMatch(/\b(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?conversation_messages\b/i);
  });

  test('bootstraps fresh Docker Postgres with Supabase-compatible roles and migration tracking', () => {
    const compose = readFileSync(
      resolve(import.meta.dir, '../../../../../docker-compose.yml'),
      'utf8'
    );
    const compatibilityInit = readFileSync(
      resolve(import.meta.dir, '../../../../../docker/postgres-init/000_supabase_compat.sql'),
      'utf8'
    );
    const migrationScript = readFileSync(
      resolve(import.meta.dir, '../../../../../scripts/migrate.sh'),
      'utf8'
    );

    expect(compose).toContain('./docker/postgres-init:/docker-entrypoint-initdb.d:ro');
    expect(compatibilityInit).toContain('CREATE ROLE service_role NOLOGIN BYPASSRLS');
    expect(compatibilityInit).toContain('CREATE ROLE authenticated NOLOGIN');
    expect(compatibilityInit).toContain("IF to_regprocedure('auth.uid()') IS NULL");
    expect(compatibilityInit).toContain('CREATE FUNCTION auth.uid()');
    expect(migrationScript).toContain('Initializing public.schema_migrations for a fresh database');
    expect(migrationScript).toContain('CREATE TABLE IF NOT EXISTS public.schema_migrations');
    expect(migrationScript).toContain('--single-transaction');
    expect(migrationScript).toContain('apply_migration_with_tracking');
  });
});
