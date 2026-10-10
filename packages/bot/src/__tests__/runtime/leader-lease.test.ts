import { afterEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { RuntimeLeaderLease } from '../../runtime/leader-lease';

const leases: RuntimeLeaderLease[] = [];
afterEach(async () => {
  await Promise.all(leases.splice(0).map(lease => lease.release()));
});

function harness(acquired = true) {
  const client = Object.assign(new EventEmitter(), {
    connect: mock(async () => {}),
    query: mock(async (_query: unknown) => ({ rows: [{ acquired, held: true }] })),
    end: mock(async () => {})
  });
  const onLost = mock(() => {});
  const acquire = async (identity = 'application-one') => {
    const lease = await RuntimeLeaderLease.acquire(client as never, identity, onLost);
    leases.push(lease);
    return lease;
  };
  return { client, onLost, acquire };
}

describe('runtime leader lease', () => {
  test('acquires once and checks session ownership without reacquiring a reentrant lock', async () => {
    const { client, acquire } = harness();
    const lease = await acquire();
    expect(lease.isHeld()).toBe(true);
    expect(await lease.verify()).toBe(true);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0]?.[0]).toMatchObject({
      text: 'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      query_timeout: 5000
    });
    expect(client.query.mock.calls[1]?.[0]).toMatchObject({
      text: expect.stringContaining('pid = pg_backend_pid()'),
      query_timeout: 5000
    });
  });

  test('refuses contention and closes the unowned session', async () => {
    const { client, acquire, onLost } = harness(false);
    await expect(acquire()).rejects.toThrow('Runtime leader lease unavailable');
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });

  test('connect failure closes the session and preserves the startup error', async () => {
    const { client, acquire } = harness();
    client.connect.mockImplementationOnce(async () => {
      throw new Error('connection unavailable');
    });
    await expect(acquire()).rejects.toThrow('connection unavailable');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  test('an expired heartbeat cannot be revived by a late successful ownership check', async () => {
    const { client, acquire, onLost } = harness();
    const lease = await acquire();
    client.query.mockImplementationOnce(async () => {
      (lease as unknown as { lastConfirmed: number }).lastConfirmed = performance.now() - 10_001;
      return { rows: [{ acquired: true, held: true }] };
    });
    expect(await lease.verify()).toBe(false);
    expect(lease.isHeld()).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  test('keys are stable per application and isolate distinct applications', async () => {
    const first = harness();
    const second = harness();
    const third = harness();
    await first.acquire();
    await second.acquire();
    await third.acquire('application-two');
    const key = (h: ReturnType<typeof harness>) =>
      (h.client.query.mock.calls[0]?.[0] as { values: string[] }).values[0];
    expect(key(first)).toBe(key(second));
    expect(key(first)).not.toBe(key(third));
  });

  test.each(['error', 'end'])('session %s revokes ownership and reports loss once', async event => {
    const { client, acquire, onLost } = harness();
    const lease = await acquire();
    client.emit(event, new Error('lost session'));
    client.emit(event, new Error('lost session'));
    expect(lease.isHeld()).toBe(false);
    expect(await lease.verify()).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
    await lease.release();
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  test('query timeout or missing lock revokes ownership rather than reconnecting', async () => {
    for (const fail of [true, false]) {
      const { client, acquire, onLost } = harness();
      const lease = await acquire();
      client.query.mockImplementationOnce(async () => {
        if (fail) throw new Error('query timeout');
        return { rows: [{ acquired: false, held: false }] };
      });
      expect(await lease.verify()).toBe(false);
      expect(lease.isHeld()).toBe(false);
      expect(onLost).toHaveBeenCalledTimes(1);
      expect(client.connect).toHaveBeenCalledTimes(1);
    }
  });

  test('concurrent admissions await the same ownership check', async () => {
    const { client, acquire } = harness();
    const lease = await acquire();
    let complete!: (value: { rows: { acquired: boolean; held: boolean }[] }) => void;
    client.query.mockImplementationOnce(() => new Promise(resolve => (complete = resolve)));
    const first = lease.verify();
    const second = lease.verify();
    expect(client.query).toHaveBeenCalledTimes(2);
    complete({ rows: [{ acquired: false, held: false }] });
    expect(await first).toBe(false);
    expect(await second).toBe(false);
  });

  test('release is idempotent and a late successful query cannot restore ownership', async () => {
    const { client, acquire, onLost } = harness();
    const lease = await acquire();
    let complete!: (value: { rows: { acquired: boolean; held: boolean }[] }) => void;
    client.query.mockImplementationOnce(() => new Promise(resolve => (complete = resolve)));
    const pending = lease.verify();
    await lease.release();
    await lease.release();
    complete({ rows: [{ acquired: true, held: true }] });
    expect(await pending).toBe(false);
    expect(lease.isHeld()).toBe(false);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(onLost).not.toHaveBeenCalled();
  });
});
