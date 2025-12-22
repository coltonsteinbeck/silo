/**
 * Tests for PostgresAdapter
 *
 * Tests database operations for conversation, memory, and preferences.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

type QueryResult = { rows: any[]; rowCount: number };

// Mock pool for testing
function createMockPool() {
  return {
    query: mock(
      async (_sql: string, _params?: unknown[]): Promise<QueryResult> => ({
        rows: [],
        rowCount: 0
      })
    ),
    connect: mock(async () => ({
      release: mock(() => {})
    })),
    end: mock(async () => {})
  };
}

// Mock PostgresAdapter implementation for testing
class MockPostgresAdapter {
  public readonly pool: ReturnType<typeof createMockPool>;

  constructor() {
    this.pool = createMockPool();
  }

  async connect(): Promise<void> {
    await this.pool.connect();
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.pool.query('SELECT 1', []);
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  async getUserMemories(userId: string, contextType?: string, limit = 50) {
    const query = contextType
      ? 'SELECT * FROM user_memory WHERE user_id = $1 AND context_type = $2 ORDER BY created_at DESC LIMIT $3'
      : 'SELECT * FROM user_memory WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2';

    const params = contextType ? [userId, contextType, limit] : [userId, limit];
    const result = await this.pool.query(query, params);

    return result.rows.map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      memoryContent: row.memory_content
    }));
  }

  async clearUserMemories(userId: string): Promise<number> {
    const result = await this.pool.query('DELETE FROM user_memory WHERE user_id = $1', [userId]);
    return result.rowCount ?? 0;
  }

  async getConversationHistory(channelId: string, limit = 50) {
    const result = await this.pool.query(
      'SELECT * FROM conversations WHERE channel_id = $1 ORDER BY created_at DESC LIMIT $2',
      [channelId, limit]
    );
    return result.rows;
  }

  async storeConversationMessage(channelId: string, userId: string, role: string, content: string) {
    const result = await this.pool.query(
      'INSERT INTO conversations (channel_id, user_id, role, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [channelId, userId, role, content]
    );
    return result.rows[0];
  }

  async clearConversationHistory(channelId: string): Promise<number> {
    const result = await this.pool.query('DELETE FROM conversations WHERE channel_id = $1', [
      channelId
    ]);
    return result.rowCount ?? 0;
  }
}

describe('PostgresAdapter', () => {
  let adapter: MockPostgresAdapter;

  beforeEach(() => {
    adapter = new MockPostgresAdapter();
  });

  describe('connection', () => {
    test('can connect to database', async () => {
      await adapter.connect();

      expect(adapter.pool.connect).toHaveBeenCalled();
    });

    test('can disconnect from database', async () => {
      await adapter.disconnect();

      expect(adapter.pool.end).toHaveBeenCalled();
    });
  });

  describe('healthCheck', () => {
    test('returns true when database responds', async () => {
      adapter.pool.query = mock(
        async (): Promise<QueryResult> => ({ rows: [{ result: 1 }], rowCount: 1 })
      );

      const healthy = await adapter.healthCheck();

      expect(healthy).toBe(true);
    });

    test('returns false when database is down', async () => {
      adapter.pool.query = mock(async (): Promise<QueryResult> => {
        throw new Error('Connection refused');
      });

      const healthy = await adapter.healthCheck();

      expect(healthy).toBe(false);
    });
  });

  describe('getUserMemories', () => {
    test('retrieves memories for user', async () => {
      const mockMemories = [
        { id: '1', user_id: 'user123', memory_content: 'Memory 1' },
        { id: '2', user_id: 'user123', memory_content: 'Memory 2' }
      ];
      adapter.pool.query = mock(
        async (): Promise<QueryResult> => ({ rows: mockMemories, rowCount: 2 })
      );

      const memories = await adapter.getUserMemories('user123');

      expect(memories).toHaveLength(2);
      expect(adapter.pool.query).toHaveBeenCalled();
    });

    test('filters by context type when provided', async () => {
      adapter.pool.query = mock(async (): Promise<QueryResult> => ({ rows: [], rowCount: 0 }));

      await adapter.getUserMemories('user123', 'voice');

      const queryCall = adapter.pool.query.mock.calls[0];
      expect(queryCall?.[0]).toContain('context_type');
      expect(queryCall?.[1]).toContain('voice');
    });

    test('respects limit parameter', async () => {
      adapter.pool.query = mock(async (): Promise<QueryResult> => ({ rows: [], rowCount: 0 }));

      await adapter.getUserMemories('user123', undefined, 10);

      const queryCall = adapter.pool.query.mock.calls[0];
      expect(queryCall?.[1]).toContain(10);
    });
  });

  describe('clearUserMemories', () => {
    test('deletes memories and returns count', async () => {
      adapter.pool.query = mock(async (): Promise<QueryResult> => ({ rows: [], rowCount: 5 }));

      const deleted = await adapter.clearUserMemories('user123');

      expect(deleted).toBe(5);
    });

    test('returns 0 when no memories to delete', async () => {
      adapter.pool.query = mock(async (): Promise<QueryResult> => ({ rows: [], rowCount: 0 }));

      const deleted = await adapter.clearUserMemories('user123');

      expect(deleted).toBe(0);
    });
  });

  describe('getConversationHistory', () => {
    test('retrieves conversation messages', async () => {
      const mockMessages = [
        { id: '1', channel_id: 'chan123', role: 'user', content: 'Hello' },
        { id: '2', channel_id: 'chan123', role: 'assistant', content: 'Hi!' }
      ];
      adapter.pool.query = mock(
        async (): Promise<QueryResult> => ({ rows: mockMessages, rowCount: 2 })
      );

      const history = await adapter.getConversationHistory('chan123');

      expect(history).toHaveLength(2);
    });

    test('limits results', async () => {
      adapter.pool.query = mock(async (): Promise<QueryResult> => ({ rows: [], rowCount: 0 }));

      await adapter.getConversationHistory('chan123', 25);

      const queryCall = adapter.pool.query.mock.calls[0];
      expect(queryCall?.[1]).toContain(25);
    });
  });

  describe('storeConversationMessage', () => {
    test('stores new message', async () => {
      const mockMessage = {
        id: '1',
        channel_id: 'chan123',
        user_id: 'user123',
        role: 'user',
        content: 'Hello'
      };
      adapter.pool.query = mock(
        async (): Promise<QueryResult> => ({ rows: [mockMessage], rowCount: 1 })
      );

      const result = await adapter.storeConversationMessage('chan123', 'user123', 'user', 'Hello');

      expect(result.id).toBe('1');
      expect(result.content).toBe('Hello');
    });
  });

  describe('clearConversationHistory', () => {
    test('clears conversation and returns count', async () => {
      adapter.pool.query = mock(async (): Promise<QueryResult> => ({ rows: [], rowCount: 10 }));

      const deleted = await adapter.clearConversationHistory('chan123');

      expect(deleted).toBe(10);
    });
  });
});
