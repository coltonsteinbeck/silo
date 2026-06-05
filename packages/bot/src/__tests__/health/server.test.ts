import { describe, expect, mock, test } from 'bun:test';
import { HealthServer } from '../../health/server';

function buildHealth(status: 'healthy' | 'unhealthy') {
  return {
    status,
    timestamp: new Date().toISOString(),
    uptime: 300,
    discord: {
      ready: status === 'healthy',
      ping: status === 'healthy' ? 25 : -1,
      guilds: 1
    },
    database: {
      connected: status === 'healthy',
      responseTime: status === 'healthy' ? 10 : undefined
    }
  };
}

function createHealthServer(statuses: Array<'healthy' | 'unhealthy'>) {
  let index = 0;
  const client = {
    isReady: () => true,
    guilds: { cache: new Map() },
    ws: { ping: 25 }
  };
  const db = {
    pool: {},
    healthCheck: async () => true
  };
  const server = new HealthServer(client as never, db as never);
  const notifyDiscordChannels = mock(async () => {});

  (server as unknown as { startTime: number }).startTime = Date.now() - 5 * 60_000;
  (
    server as unknown as { notifyDiscordChannels: typeof notifyDiscordChannels }
  ).notifyDiscordChannels = notifyDiscordChannels;
  (
    server as unknown as { getHealthStatus: () => Promise<ReturnType<typeof buildHealth>> }
  ).getHealthStatus = async () => {
    const status = statuses[Math.min(index, statuses.length - 1)] || 'healthy';
    index += 1;
    return buildHealth(status);
  };

  return { server, notifyDiscordChannels };
}

async function runDiscordCheck(server: HealthServer): Promise<void> {
  await (
    server as unknown as { runDiscordHealthNotificationCheck: () => Promise<void> }
  ).runDiscordHealthNotificationCheck();
}

describe('HealthServer Discord health notifications', () => {
  test('does not notify routine healthy checks', async () => {
    const { server, notifyDiscordChannels } = createHealthServer(['healthy']);

    await runDiscordCheck(server);

    expect(notifyDiscordChannels).not.toHaveBeenCalled();
  });

  test('suppresses transient unhealthy checks before threshold', async () => {
    const { server, notifyDiscordChannels } = createHealthServer(['unhealthy', 'unhealthy']);

    await runDiscordCheck(server);
    await runDiscordCheck(server);

    expect(notifyDiscordChannels).not.toHaveBeenCalled();
  });

  test('notifies once for sustained outage and suppresses duplicates', async () => {
    const { server, notifyDiscordChannels } = createHealthServer([
      'unhealthy',
      'unhealthy',
      'unhealthy',
      'unhealthy'
    ]);

    await runDiscordCheck(server);
    await runDiscordCheck(server);
    await runDiscordCheck(server);
    await runDiscordCheck(server);

    expect(notifyDiscordChannels).toHaveBeenCalledTimes(1);
    expect(notifyDiscordChannels).toHaveBeenCalledWith('unhealthy');
  });

  test('notifies recovery only after an outage alert was sent', async () => {
    const { server, notifyDiscordChannels } = createHealthServer([
      'unhealthy',
      'unhealthy',
      'healthy',
      'unhealthy',
      'unhealthy',
      'unhealthy',
      'healthy'
    ]);

    await runDiscordCheck(server);
    await runDiscordCheck(server);
    await runDiscordCheck(server);
    expect(notifyDiscordChannels).not.toHaveBeenCalled();

    await runDiscordCheck(server);
    await runDiscordCheck(server);
    await runDiscordCheck(server);
    await runDiscordCheck(server);

    expect(notifyDiscordChannels).toHaveBeenCalledTimes(2);
    expect(notifyDiscordChannels).toHaveBeenNthCalledWith(1, 'unhealthy');
    expect(notifyDiscordChannels).toHaveBeenNthCalledWith(2, 'healthy');
  });

  test('still sends shutdown notification', async () => {
    const { server, notifyDiscordChannels } = createHealthServer(['healthy']);

    await server.stop();

    expect(notifyDiscordChannels).toHaveBeenCalledWith('shutdown');
  });
});
