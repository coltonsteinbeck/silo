import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';

// Run with: bun --no-env-file packages/bot/src/__tests__/runtime/offline-startup-smoke.fixture.ts
// This runs the real startBot wiring with fake transports and synthetic configuration.
// It never reads the checkout's environment file or contacts Discord or PostgreSQL.
if (existsSync('/tmp/.env') || existsSync('/.env')) {
  throw new Error('Offline fixture requires an environment-free temporary parent');
}
for (const key of Object.keys(process.env)) delete process.env[key];
const nativeFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error('Network fetch is forbidden in the offline startup fixture');
}) as unknown as typeof fetch;

const appId = 'fixture-application';
const guildId = 'fixture-guild';
const databaseUrl = 'postgresql://fixture:fixture@fixture.invalid/isolated_fixture';
const token = 'synthetic-token-'.repeat(5);
Object.assign(process.env, {
  APP_ENV: 'development',
  NODE_ENV: 'development',
  DISCORD_COMMAND_SYNC_MODE: 'none',
  DISCORD_CLIENT_ID: appId,
  DISCORD_GUILD_ID: guildId,
  DISCORD_TOKEN: token,
  DATABASE_URL: databaseUrl,
  DB_SSL: 'false',
  ENABLE_VOICE: 'false',
  ENABLE_IMAGES: 'false',
  LANGFUSE_ENABLED: 'false'
});

const discord = await import('discord.js');
const postgres = await import('pg');
const calls: string[] = [];

mock.module('pg', () => ({
  ...postgres,
  Client: class {
    constructor() {
      calls.push('postgres-client-mocked');
    }
  }
}));

class FixtureClient extends EventEmitter {
  static latest: FixtureClient | undefined;
  user = { id: appId, tag: 'fixture' };
  guilds = { cache: new discord.Collection([[guildId, { id: guildId }]]) };
  constructor(_options: unknown) {
    super();
    FixtureClient.latest = this;
    calls.push('client-created');
  }
  async login(value: string) {
    assert.equal(value, token);
    calls.push('client-login');
    queueMicrotask(() => this.emit(discord.Events.ClientReady, this));
    return 'synthetic-session';
  }
  destroy() {
    calls.push('client-destroy');
  }
}
class ForbiddenRest {
  constructor() {
    throw new Error('Discord REST must not be constructed');
  }
}
mock.module('discord.js', () => ({ ...discord, Client: FixtureClient, REST: ForbiddenRest }));

const source = (file: string) => new URL(`../../${file}`, import.meta.url).pathname;
mock.module(source('database/postgres.ts'), () => ({
  PostgresAdapter: class {
    pool = { options: { connectionString: databaseUrl }, query: async () => ({ rows: [] }) };
    constructor(value: string) {
      assert.equal(value, databaseUrl);
      calls.push('database-adapter-created');
    }
    async connect() {
      calls.push('database-connect-mocked');
    }
    getLastMigrationSummary() {
      return null;
    }
  }
}));
mock.module(source('runtime/leader-lease.ts'), () => ({
  RuntimeLeaderLease: class {
    static async acquire(_client: unknown, value: string) {
      assert.equal(value, appId);
      calls.push('leader-lease-mocked');
      return { verify: async () => true, isHeld: () => true, release: async () => {} };
    }
  }
}));
mock.module(source('runtime/process-lock.ts'), () => ({
  acquireProcessLock: () => {
    calls.push('process-lock-mocked');
    return () => {};
  }
}));
mock.module(source('health/server.ts'), () => ({
  HealthServer: class {
    async start() {
      calls.push('health-start-mocked');
    }
  }
}));
mock.module(source('services/cost-aggregator.ts'), () => ({
  CostAggregator: class {
    start() {
      calls.push('cost-start-mocked');
    }
  }
}));
mock.module(source('commands/index.ts'), () => ({
  createCommands: () => new discord.Collection()
}));

const security = await import(source('security/index.ts'));
mock.module(source('security/index.ts'), () => ({
  ...security,
  guildManager: {
    init: () => calls.push('guild-manager-init-mocked'),
    setClient: () => calls.push('guild-manager-client-mocked'),
    ensureGuildsRegistered: async () => {
      calls.push('guild-sync-mocked');
      return { synced: 0, skipped: 1 };
    }
  },
  contentSanitizer: {
    init: () => calls.push('sanitizer-init-mocked'),
    prewarmRuntime: async () => {}
  },
  inactivityScheduler: {
    init: () => calls.push('scheduler-init-mocked'),
    start: () => calls.push('scheduler-start-mocked')
  },
  initializeManagedGuildPolicyRegistry: async () => calls.push('policy-registry-mocked'),
  prewarmGuardrailsRuntime: async () => calls.push('guardrails-prewarm-mocked')
}));

const intervals: ReturnType<typeof setInterval>[] = [];
const nativeInterval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const interval = nativeInterval(...args);
  interval.unref();
  intervals.push(interval);
  return interval;
}) as typeof setInterval;

const fixtureDirectory = mkdtempSync('/tmp/silo-offline-startup-');
process.chdir(fixtureDirectory);

try {
  const { startBot } = await import(source('app.ts'));
  await startBot();
  for (let attempt = 0; attempt < 100 && !calls.includes('guardrails-prewarm-mocked'); attempt++) {
    await Bun.sleep(10);
  }
  assert(FixtureClient.latest, 'fixture client not created');
  for (const required of [
    'process-lock-mocked',
    'database-adapter-created',
    'postgres-client-mocked',
    'leader-lease-mocked',
    'database-connect-mocked',
    'policy-registry-mocked',
    'health-start-mocked',
    'client-login',
    'guild-sync-mocked',
    'guardrails-prewarm-mocked'
  ])
    assert(calls.includes(required), `missing startup step: ${required}`);
  assert(!calls.includes('client-destroy'));
  process.stdout.write(JSON.stringify({ status: 'offline-startup-passed', steps: calls }) + '\n');
} finally {
  for (const interval of intervals) clearInterval(interval);
  globalThis.setInterval = nativeInterval;
  globalThis.fetch = nativeFetch;
  FixtureClient.latest?.destroy();
  process.chdir('/tmp');
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
