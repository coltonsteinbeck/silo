import { describe, expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';
import { Client } from 'pg';
import { PostgresAdapter } from '../../database/postgres';

const enabled = process.env.RUN_POOL_REUSE_DB_TESTS === 'true';
const suite = enabled ? describe : describe.skip;

suite('application pool heartbeat reuse on disposable PostgreSQL', () => {
  test('reuses one connection across heartbeats and recovers after server disconnect', async () => {
    const url = process.env.POOL_REUSE_TEST_DATABASE_URL;
    const expectedDatabase = process.env.POOL_REUSE_TEST_DATABASE_NAME;
    if (!url || !expectedDatabase) throw new Error('Disposable database binding is required');
    const target = new URL(url);
    const localAddresses = Object.values(networkInterfaces())
      .flat()
      .filter(address => address?.internal && address.family === 'IPv4')
      .map(address => address!.address);
    if (
      !localAddresses.includes(target.hostname) ||
      target.port !== '5432' ||
      !/^[a-z][a-z0-9_]{8,62}$/.test(expectedDatabase) ||
      target.pathname !== `/${expectedDatabase}`
    ) {
      throw new Error('Pool reuse test requires its exact local disposable database');
    }

    const adapter = new PostgresAdapter(url, { ssl: false, maxConnections: 2 });
    const control = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    let opened = 0;
    adapter.pool.on('connect', () => opened++);
    try {
      await control.connect();
      expect(await adapter.healthCheck()).toBe(true);
      const first = await adapter.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(opened).toBe(1);

      await Bun.sleep(70_000);
      expect(await adapter.healthCheck()).toBe(true);
      const reused = await adapter.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect(reused.rows[0]?.pid).toBe(first.rows[0]?.pid);
      expect(opened).toBe(1);

      const terminated = await control.query<{ terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [first.rows[0]?.pid]
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      let recovered = false;
      for (let attempt = 0; attempt < 20 && !recovered; attempt++) {
        await Bun.sleep(100);
        recovered = await adapter.healthCheck();
      }
      expect(recovered).toBe(true);
      expect(opened).toBe(2);
      expect(adapter.pool.totalCount).toBeLessThanOrEqual(2);
    } finally {
      await adapter.disconnect();
      await control.end();
    }
  }, 90_000);
});
