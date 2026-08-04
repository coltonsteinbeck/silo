/**
 * Test Setup and Mock Factories
 *
 * Provides mock implementations for Discord.js, database adapters,
 * and other dependencies used across unit tests.
 */

import { mock } from 'bun:test';

// Unit and graph tests must never inherit production provider credentials from
// a developer's local .env. Individual provider tests can install explicit
// mock credentials after this preload runs.
for (const credential of [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  'GOOGLE_API_KEY',
  'LOCAL_API_KEY'
]) {
  delete process.env[credential];
}
process.env.OPENAI_GUARDRAILS_ENABLED = 'false';
process.env.OPENAI_MODERATION_ENABLED = 'false';

const providerApiHosts = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'api.x.ai',
  'generativelanguage.googleapis.com'
]);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1]
) => {
  const url =
    typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
  if (providerApiHosts.has(url.hostname)) {
    throw new Error(`Outbound provider call blocked by test harness: ${url.hostname}`);
  }
  return nativeFetch(input, init);
}) as typeof globalThis.fetch;

// ============================================================================
// Discord.js Mocks
// ============================================================================

export interface MockInteractionOptions {
  guildId?: string;
  channelId?: string;
  userId?: string;
  username?: string;
  options?: Record<string, unknown>;
  member?: MockGuildMember;
}

export interface MockGuildMember {
  id: string;
  permissions: {
    has: (permission: string | bigint) => boolean;
  };
  roles: {
    cache: Map<string, { id: string; name: string }>;
  };
}

export function createMockInteraction(opts: MockInteractionOptions = {}) {
  const {
    guildId = '123456789',
    channelId = '987654321',
    userId = '111222333',
    username = 'testuser',
    options = {},
    member
  } = opts;

  const replied = { value: false };
  const deferred = { value: false };
  const replies: unknown[] = [];

  return {
    guildId,
    channelId,
    user: {
      id: userId,
      username,
      tag: `${username}#0000`
    },
    member: member ?? createMockGuildMember({ id: userId }),
    replied: replied.value,
    deferred: deferred.value,

    options: {
      getString: mock((name: string, _required?: boolean) => options[name] as string | null),
      getInteger: mock((name: string, _required?: boolean) => options[name] as number | null),
      getNumber: mock((name: string, _required?: boolean) => options[name] as number | null),
      getBoolean: mock((name: string, _required?: boolean) => options[name] as boolean | null),
      getUser: mock((name: string, _required?: boolean) => options[name] ?? null),
      getChannel: mock((name: string, _required?: boolean) => options[name] ?? null),
      getSubcommand: mock(() => options['subcommand'] as string),
      getSubcommandGroup: mock(() => options['subcommandGroup'] as string | null)
    },

    reply: mock(async (content: unknown) => {
      replied.value = true;
      replies.push(content);
      return content;
    }),

    editReply: mock(async (content: unknown) => {
      replies.push(content);
      return content;
    }),

    deferReply: mock(async (_opts?: { ephemeral?: boolean }) => {
      deferred.value = true;
    }),

    followUp: mock(async (content: unknown) => {
      replies.push(content);
      return content;
    }),

    showModal: mock(async (_modal: unknown) => {}),

    // Test helpers
    _getReplies: () => replies,
    _isReplied: () => replied.value,
    _isDeferred: () => deferred.value
  };
}

export function createMockGuildMember(
  opts: { id?: string; isAdmin?: boolean } = {}
): MockGuildMember {
  const { id = '111222333', isAdmin = false } = opts;

  return {
    id,
    permissions: {
      has: mock((_permission: string | bigint) => isAdmin)
    },
    roles: {
      cache: new Map([['role1', { id: 'role1', name: 'Member' }]])
    }
  };
}

// ============================================================================
// Database Mocks
// ============================================================================

export interface MockQueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export function createMockPool() {
  const queryResults: MockQueryResult[] = [];
  let queryIndex = 0;

  return {
    query: mock(async (_sql: string, _params?: unknown[]): Promise<MockQueryResult> => {
      const result = queryResults[queryIndex] ?? { rows: [], rowCount: 0 };
      queryIndex++;
      return result;
    }),

    connect: mock(async () => ({
      query: mock(async () => ({ rows: [], rowCount: 0 })),
      release: mock(() => {})
    })),

    end: mock(async () => {}),

    // Test helpers
    _setQueryResults: (results: MockQueryResult[]) => {
      queryResults.length = 0;
      queryResults.push(...results);
      queryIndex = 0;
    },
    _resetQueryIndex: () => {
      queryIndex = 0;
    }
  };
}

export function createMockDatabaseAdapter() {
  const memories = new Map<string, { userId: string; content: string }[]>();

  return {
    connect: mock(async () => {}),
    disconnect: mock(async () => {}),

    getMemory: mock(async (userId: string, guildId: string) => {
      const key = `${guildId}:${userId}`;
      return memories.get(key) ?? [];
    }),

    setMemory: mock(async (userId: string, guildId: string, content: string) => {
      const key = `${guildId}:${userId}`;
      const existing = memories.get(key) ?? [];
      existing.push({ userId, content });
      memories.set(key, existing);
    }),

    clearMemory: mock(async (userId: string, guildId: string) => {
      const key = `${guildId}:${userId}`;
      memories.delete(key);
    }),

    getConversationHistory: mock(async () => []),
    addMessage: mock(async () => {}),

    pool: createMockPool(),

    // Test helpers
    _getMemories: () => memories,
    _clearAll: () => memories.clear()
  };
}

export function createMockAdminAdapter() {
  const serverConfigs = new Map<string, Record<string, unknown>>();
  const systemPrompts = new Map<string, { prompt: string | null; enabled: boolean }>();

  return {
    getServerConfig: mock(async (guildId: string) => {
      return serverConfigs.get(guildId) ?? null;
    }),

    setServerConfig: mock(async (config: { guildId: string } & Record<string, unknown>) => {
      serverConfigs.set(config.guildId, config);
      return config;
    }),

    updateSafetyFeatures: mock(
      async (
        guildId: string,
        updates: { edgyModeEnabled: boolean; deterministicSentimentReviewEnabled?: boolean }
      ) => {
        const existing = serverConfigs.get(guildId) ?? { guildId };
        const existingFeatures = (existing.featuresEnabled as Record<string, unknown>) ?? {};
        const deterministicSentimentReviewEnabled =
          updates.deterministicSentimentReviewEnabled ??
          (existingFeatures.deterministicSentimentReviewEnabled as boolean | undefined) ??
          updates.edgyModeEnabled;

        const next = {
          ...existing,
          guildId,
          featuresEnabled: {
            ...existingFeatures,
            edgyModeEnabled: updates.edgyModeEnabled,
            deterministicSentimentReviewEnabled
          }
        };

        serverConfigs.set(guildId, next);
        return next;
      }
    ),

    getChannelConfig: mock(async () => null),
    setChannelConfig: mock(async () => {}),

    getAlertsChannel: mock(async () => null),
    setAlertsChannel: mock(async () => {}),

    getSystemPrompt: mock(async (guildId: string, _forVoice?: boolean) => {
      return systemPrompts.get(guildId) ?? { prompt: null, enabled: false };
    }),

    setSystemPrompt: mock(
      async (
        guildId: string,
        prompt: string | null,
        opts?: { forVoice?: boolean; enabled?: boolean }
      ) => {
        systemPrompts.set(guildId, { prompt, enabled: opts?.enabled ?? true });
      }
    ),

    logAudit: mock(async () => {}),
    logAnalytics: mock(async () => {}),

    getCommandStats: mock(async () => ({})),
    getUserRole: mock(async () => ({ roleTier: 'member' as const })),

    // Quota methods
    getUserUsage: mock(async () => ({ text_tokens: 0, images: 0, voice_minutes: 0 })),
    incrementUsage: mock(async () => {}),
    getGuildQuotas: mock(async () => null),

    // Test helpers
    _setServerConfig: (guildId: string, config: Record<string, unknown>) => {
      serverConfigs.set(guildId, config);
    },
    _setSystemPrompt: (guildId: string, prompt: string | null, enabled = true) => {
      systemPrompts.set(guildId, { prompt, enabled });
    },
    _clearAll: () => {
      serverConfigs.clear();
      systemPrompts.clear();
    }
  };
}

// ============================================================================
// Provider Mocks
// ============================================================================

export function createMockProviderRegistry(): {
  getTextProvider: ReturnType<typeof mock>;
  getImageProvider: ReturnType<typeof mock>;
  getVideoProvider: ReturnType<typeof mock>;
  getAvailableProviders: ReturnType<typeof mock>;
} {
  return {
    getTextProvider: mock((name?: string) => ({
      name: name ?? 'openai',
      isConfigured: () => true,
      generateText: mock(async () => ({
        content: 'Mock response',
        model: 'gpt-4o-mini',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
      }))
    })),

    getImageProvider: mock((name?: string) => ({
      name: name ?? 'openai',
      isConfigured: () => true,
      generateImage: mock(async () => ({
        url: 'https://example.com/image.png',
        revisedPrompt: 'A mock image'
      }))
    })),

    getVideoProvider: mock((name?: string) => ({
      name: name ?? 'xai',
      isConfigured: () => true,
      generateVideo: mock(async () => ({
        url: 'https://example.com/video.mp4',
        model: 'grok-imagine-video',
        duration: 8
      }))
    })),

    getAvailableProviders: mock(() => ({
      text: ['openai', 'anthropic'],
      image: ['openai', 'xai', 'google'],
      video: ['xai']
    }))
  };
}

// ============================================================================
// Permission Manager Mock
// ============================================================================

export function createMockPermissionManager() {
  return {
    checkPermission: mock(async () => ({ allowed: true, reason: null })),
    getUserTier: mock(async () => 'member' as const),
    isAdmin: mock(async () => false),
    isModerator: mock(async () => false),

    // Test helpers
    _setAdmin: (isAdmin: boolean) => {
      (createMockPermissionManager().isAdmin as ReturnType<typeof mock>).mockReturnValue(
        Promise.resolve(isAdmin)
      );
    }
  };
}

// ============================================================================
// Environment Helpers
// ============================================================================

/**
 * Temporarily set environment variables for a test
 * Returns a cleanup function to restore original values
 */
export function withEnv(envVars: Record<string, string | undefined>): () => void {
  const original: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(envVars)) {
    original[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/**
 * Run a function with temporary environment variables
 */
export async function runWithEnv<T>(
  envVars: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
  const cleanup = withEnv(envVars);
  try {
    return await fn();
  } finally {
    cleanup();
  }
}
