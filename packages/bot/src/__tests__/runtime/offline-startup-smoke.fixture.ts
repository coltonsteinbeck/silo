import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { runDiscordRegression, syntheticDiscordId } from './discord-regression.fixture';

// Run with: bun --no-env-file packages/bot/src/__tests__/runtime/offline-startup-smoke.fixture.ts
// This runs the real startBot wiring with fake transports and synthetic configuration.
// It never reads the checkout's environment file or contacts Discord or PostgreSQL.
if (existsSync('/tmp/.env') || existsSync('/.env')) {
  throw new Error('Offline fixture requires an environment-free temporary parent');
}
for (const key of Object.keys(process.env)) delete process.env[key];
const nativeFetch = globalThis.fetch;
let unexpectedFetchCount = 0;
globalThis.fetch = (() => {
  unexpectedFetchCount++;
  throw new Error('Network fetch is forbidden in the offline startup fixture');
}) as unknown as typeof fetch;

const startupMembershipChange = process.argv[2];
const searchEnabled = startupMembershipChange === 'regression-search';
const regression = startupMembershipChange === 'regression' || searchEnabled;
const changingMembership =
  startupMembershipChange === 'join' || startupMembershipChange === 'leave';
const scoped = changingMembership || regression;
const appId = syntheticDiscordId(1);
const guildId = syntheticDiscordId(2);
const databaseUrl = 'postgresql://fixture:fixture@fixture.invalid/isolated_fixture';
const token = 'synthetic-token-'.repeat(5);
Object.assign(process.env, {
  APP_ENV: 'development',
  NODE_ENV: 'development',
  DISCORD_COMMAND_SYNC_MODE: scoped ? 'guild-only' : 'none',
  DISCORD_CLIENT_ID: appId,
  DISCORD_GUILD_ID: guildId,
  DISCORD_TOKEN: token,
  DATABASE_URL: databaseUrl,
  DB_SSL: 'false',
  ENABLE_VOICE: 'false',
  ENABLE_IMAGES: 'false',
  AGENT_SEARCH_ENABLED: String(searchEnabled),
  LANGFUSE_ENABLED: 'false'
});

const discord = await import('discord.js');
const SdkClient = discord.Client;
const postgres = await import('pg');
const calls: string[] = [];
const commandWrites: Array<{ route: string; body: Array<{ name: string; type: number }> }> = [];
const claims = new Set<string>();
const persisted: unknown[] = [];
const modelInputs: unknown[] = [];
let moderationUnavailable = false;

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
class FixtureRest {
  constructor() {
    if (!scoped) throw new Error('Discord REST must not be constructed');
  }
  setToken(value: string) {
    assert.equal(value, token);
    return this;
  }
  async put(route: string, { body }: { body: Array<{ name: string; type: number }> }) {
    commandWrites.push({ route, body });
  }
}
mock.module('discord.js', () => ({ ...discord, Client: FixtureClient, REST: FixtureRest }));

const source = (file: string) => new URL(`../../${file}`, import.meta.url).pathname;
const { PostgresAdapter } = await import(source('database/postgres.ts'));
mock.module(source('database/postgres.ts'), () => ({
  PostgresAdapter: class {
    pool = {
      options: { connectionString: databaseUrl },
      query: async (sql: string, values?: unknown[]) => {
        if (!sql.includes('INSERT INTO assistant_message_ingress')) return { rows: [] };
        const id = String(values?.[0]);
        if (claims.has(id)) return { rows: [], rowCount: 0 };
        claims.add(id);
        return { rows: [{ message_id: id }], rowCount: 1 };
      }
    };
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
    claimAssistantMessage(
      message: Parameters<typeof PostgresAdapter.prototype.claimAssistantMessage>[0]
    ) {
      return PostgresAdapter.prototype.claimAssistantMessage.call(this, message);
    }
    async getPromptContext() {
      return {
        messages: [],
        scope: 'none',
        selectedTurnCount: 0,
        excludedTurnCount: 0,
        exclusionReasons: []
      };
    }
    async storeConversationTurn(turn: unknown) {
      persisted.push(turn);
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
if (regression) {
  Object.assign(process.env, {
    OPENAI_API_KEY: 'synthetic-key',
    OPENAI_MODERATION_ENABLED: 'true',
    OPENAI_GUARDRAILS_ENABLED: 'false',
    AGENT_GRAPH_MODE: 'off'
  });
  const registry = await import(source('providers/registry.ts'));
  const promptSafety = await import(source('security/prompt-safety.ts'));
  promptSafety.setPromptSafetyRuntimeForTests({
    moderationRunner: async () => {
      if (moderationUnavailable) throw new Error('Fixture moderation unavailable');
      return { flaggedCategories: [], scores: {} };
    }
  });
  mock.module(source('providers/registry.ts'), () => ({
    ...registry,
    ProviderRegistry: class extends registry.ProviderRegistry {
      getAvailableProviders() {
        return {
          text: ['openai'],
          vision: [],
          image: [],
          video: [],
          webSearch: [],
          embeddings: []
        };
      }
      getWebSearchProvider(name?: string) {
        if (name !== 'openai' || !searchEnabled) return null;
        return {
          name,
          isConfigured: () => true,
          searchWeb: async () => {
            throw new Error('Unexpected web search during offline startup');
          }
        };
      }
      getTextRoute() {
        return {
          options: { model: 'fixture-text', maxTokens: 100 },
          provider: {
            name: 'openai',
            capabilities: { vision: false },
            isConfigured: () => true,
            generateText: async (messages: unknown) => {
              modelInputs.push(messages);
              return {
                content: 'The chain transfers power.',
                model: 'fixture-text',
                usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 }
              };
            }
          }
        };
      }
    }
  }));
  mock.module(source('database/admin-adapter.ts'), () => ({
    AdminAdapter: class {
      async getServerRuntimeConfig() {
        return { systemPrompt: { prompt: null, enabled: false }, retainMessagesDays: 7 };
      }
      async getUserRole() {
        return null;
      }
      async getPatchNotesWebhook() {
        calls.push('patch-notes-status-read');
        return null;
      }
      async logEvent() {}
    }
  }));
  const { QuotaMiddleware } = await import(source('middleware/quota.ts'));
  mock.module(source('middleware/quota.ts'), () => ({
    QuotaMiddleware: class extends QuotaMiddleware {
      async checkQuota() {
        return { allowed: true, remaining: 10000, max: 10000 };
      }
      async estimateResponseTokensWithCap() {
        return 100;
      }
      getChargeableTextTokens() {
        return 6;
      }
      async logAccuracy() {}
      async recordUsage() {}
    }
  }));
} else {
  mock.module(source('commands/index.ts'), () => ({
    createCommands: () => new discord.Collection()
  }));
}

const security = await import(source('security/index.ts'));
const sanitizer = security.contentSanitizer;
if (regression) sanitizer.prewarmRuntime = async () => {};
mock.module(source('security/index.ts'), () => ({
  ...security,
  guildManager: {
    init: () => calls.push('guild-manager-init-mocked'),
    updateActivity: async () => {},
    setClient: () => calls.push('guild-manager-client-mocked'),
    ensureGuildsRegistered: async () => {
      calls.push('guild-sync-mocked');
      const client = FixtureClient.latest;
      assert(client);
      if (startupMembershipChange === 'join') {
        const otherGuild = { id: 'fixture-other-guild' };
        client.guilds.cache.set(otherGuild.id, otherGuild);
        client.emit(discord.Events.GuildCreate, otherGuild);
      } else if (startupMembershipChange === 'leave') {
        client.guilds.cache.delete(guildId);
        client.emit(discord.Events.GuildDelete, { id: guildId });
      }
      return { synced: 0, skipped: 1 };
    }
  },
  contentSanitizer: regression
    ? sanitizer
    : {
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
const cleanupDirectory = () => rmSync(fixtureDirectory, { recursive: true, force: true });
process.once('exit', cleanupDirectory);
process.chdir(fixtureDirectory);

try {
  const { startBot } = await import(source('app.ts'));
  await startBot();
  for (let attempt = 0; attempt < 100 && !calls.includes('client-login'); attempt++) {
    await Bun.sleep(10);
  }
  await Bun.sleep(25);
  assert(FixtureClient.latest, 'fixture client not created');
  if (regression) {
    await runDiscordRegression({
      discord,
      SdkClient,
      appClient: FixtureClient.latest,
      appId,
      guildId,
      calls,
      claims,
      persisted,
      modelInputs,
      commandWrites,
      searchEnabled,
      disableModeration: () => {
        moderationUnavailable = true;
      }
    });
    assert.equal(unexpectedFetchCount, 0, 'a network request was attempted');
  }
  assert(!changingMembership, 'Startup continued after guild membership changed');
  for (const required of [
    'process-lock-mocked',
    'database-adapter-created',
    'postgres-client-mocked',
    'leader-lease-mocked',
    'database-connect-mocked',
    'policy-registry-mocked',
    'health-start-mocked',
    'client-login'
  ])
    assert(calls.includes(required), `missing startup step: ${required}`);
  if (!regression) {
    for (const forbidden of [
      'cost-start-mocked',
      'guild-manager-client-mocked',
      'guild-sync-mocked',
      'scheduler-init-mocked',
      'scheduler-start-mocked',
      'guardrails-prewarm-mocked'
    ])
      assert(!calls.includes(forbidden), `passive startup unexpectedly ran: ${forbidden}`);
  }
  assert(!calls.includes('scheduler-init-mocked'), 'scoped startup initialized guild eviction');
  assert(!calls.includes('scheduler-start-mocked'), 'scoped startup started guild eviction');
  assert(!calls.includes('client-destroy'));
  process.stdout.write(JSON.stringify({ status: 'offline-startup-passed', steps: calls }) + '\n');
} finally {
  for (const interval of intervals) clearInterval(interval);
  globalThis.setInterval = nativeInterval;
  globalThis.fetch = nativeFetch;
  FixtureClient.latest?.destroy();
  process.chdir('/tmp');
  process.off('exit', cleanupDirectory);
  cleanupDirectory();
}
