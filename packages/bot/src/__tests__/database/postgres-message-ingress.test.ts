import { describe, expect, mock, test } from 'bun:test';
import { PostgresAdapter } from '../../database/postgres';

const message = {
  messageId: 'message-fixture',
  guildId: 'guild-fixture',
  channelId: 'channel-fixture',
  userId: 'user-fixture'
};

function adapterWithQuery(query: ReturnType<typeof mock>): PostgresAdapter {
  const adapter = new PostgresAdapter('postgresql://fixture:fixture@example.invalid/fixture');
  Object.defineProperty(adapter, 'pool', { value: { query } });
  return adapter;
}

describe('message ingress admission', () => {
  test('new ingress is admitted and a conflicting message is suppressed', async () => {
    const query = mock(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1 }));
    const adapter = adapterWithQuery(query);
    expect(await adapter.claimAssistantMessage(message)).toBe(true);
    expect(query.mock.calls[0]?.[1]).toEqual([
      'message-fixture',
      'guild-fixture',
      'channel-fixture',
      'user-fixture'
    ]);
    query.mockImplementation(async () => ({ rowCount: 0 }));
    expect(await adapter.claimAssistantMessage(message)).toBe(false);
  });
  test('database failures cannot authorize work', async () => {
    const adapter = adapterWithQuery(
      mock(async () => {
        throw Error('Fixture unavailable');
      })
    );
    await expect(adapter.claimAssistantMessage(message)).rejects.toThrow('Fixture unavailable');
  });
  test('ingress cleanup retains the bounded replay window', async () => {
    const query = mock(async () => ({ rowCount: 0 }));
    await adapterWithQuery(query).cleanupAssistantMessageIngress();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INTERVAL '90 days'"));
  });
});
