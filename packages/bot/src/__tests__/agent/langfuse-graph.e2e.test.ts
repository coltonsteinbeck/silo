import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import type { Config, TextProvider } from '@silo/core';
import type { AgentGraphInput } from '../../agent/types';
import type { AgentToolExecutor } from '../../agent/tool-executor';

type ObservationRecord = {
  name: string;
  type: 'span' | 'generation' | 'guardrail';
  updates: Array<Record<string, unknown>>;
};

const observations: ObservationRecord[] = [];
let activeTraceId: string | null = null;

mock.module('@langfuse/tracing', () => ({
  getActiveTraceId: () => activeTraceId,
  propagateAttributes: async <T>(
    _attributes: Record<string, unknown>,
    fn: () => Promise<T>
  ): Promise<T> => fn(),
  setLangfuseTracerProvider: mock(() => {}),
  startActiveObservation: async <T>(
    name: string,
    fn: (observation: { update: (attributes: Record<string, unknown>) => void }) => Promise<T>,
    options?: { asType?: 'generation' | 'guardrail' }
  ): Promise<T> => {
    const previousTraceId = activeTraceId;
    activeTraceId ||= 'trace-e2e';

    const record: ObservationRecord = {
      name,
      type: options?.asType || 'span',
      updates: []
    };
    observations.push(record);

    try {
      return await fn({
        update: attributes => {
          record.updates.push(attributes);
        }
      });
    } finally {
      activeTraceId = previousTraceId;
    }
  }
}));

mock.module('@langfuse/otel', () => ({
  LangfuseSpanProcessor: class LangfuseSpanProcessor {
    constructor(readonly options: unknown) {}
  }
}));

mock.module('@opentelemetry/context-async-hooks', () => ({
  AsyncLocalStorageContextManager: class AsyncLocalStorageContextManager {}
}));

const providerShutdown = mock(async () => {});

mock.module('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: class NodeTracerProvider {
    constructor(readonly options: unknown) {}

    register = mock(() => {});
    shutdown = providerShutdown;
  }
}));

function createLangfuseEnabledConfig(): Config {
  return {
    app: {
      name: 'silo',
      environment: 'test',
      hostName: 'test-host',
      promptVersion: 'test-prompt'
    },
    discord: {
      token: 'x'.repeat(50),
      clientId: 'client-id'
    },
    providers: {},
    database: {
      url: 'postgres://localhost/silo',
      maxConnections: 1,
      ssl: false
    },
    redis: {
      url: 'redis://localhost:6379',
      maxRetries: 3
    },
    rateLimits: {
      commandsPerUser: 10,
      aiRequestsPerGuild: 50,
      voiceSessionsPerGuild: 3
    },
    features: {
      enableRAG: false,
      enableLocalModels: false,
      enableVoice: false,
      enableImages: true
    },
    memory: {
      retrievalLimit: 4,
      fallbackLimit: 1,
      triggerThreshold: 0.45,
      semanticMinSimilarity: 0.62,
      keywordMentionThreshold: 0.55,
      keywordWeight: 0.15,
      semanticWeight: 0.75,
      cueWeight: 0.07,
      entityWeight: 0.03
    },
    security: {
      healthCheckSecret: '',
      alertWebhookUrl: '',
      enableMonitoring: false,
      urlPolicy: {
        denylistDomains: [],
        allowlistDomains: [],
        enforceAllowlist: false,
        blockKnownShorteners: true,
        safeBrowsingApiKey: ''
      }
    },
    langfuse: {
      enabled: true,
      publicKey: 'pk-test',
      secretKey: 'sk-test',
      userHashSalt: 'salt',
      baseUrl: 'https://langfuse.test',
      sampleRate: 1,
      environment: 'test',
      release: 'release/silo-1.1',
      timeout: 5,
      flushAt: 1,
      flushInterval: 1,
      exportMode: 'immediate'
    }
  };
}

describe('bounded graph Langfuse e2e trace', () => {
  let telemetry: typeof import('../../telemetry/langfuse-client');
  let graph: typeof import('../../agent/bounded-graph');
  let config: typeof import('../../agent/config');
  let metadata: typeof import('../../telemetry/langfuse-metadata');

  beforeAll(async () => {
    telemetry = await import('../../telemetry/langfuse-client');
    graph = await import('../../agent/bounded-graph');
    config = await import('../../agent/config');
    metadata = await import('../../telemetry/langfuse-metadata');
    telemetry.initializeLangfuseTracing(createLangfuseEnabledConfig());
  });

  afterAll(async () => {
    await telemetry.shutdownLangfuseTracing();
  });

  test('records root trace and graph node observations for a searched Discord turn', async () => {
    observations.length = 0;

    const textProvider: TextProvider = {
      name: 'anthropic',
      capabilities: { vision: true },
      isConfigured: () => true,
      generateText: mock(async () => ({
        content: 'Street Fighter 6 patch notes summary with citations.',
        model: 'gpt-test',
        usage: {
          promptTokens: 20,
          completionTokens: 10,
          totalTokens: 30
        }
      }))
    };
    const executor: AgentToolExecutor = mock(async request => ({
      name: request.name as 'web_search',
      status: 'success' as const,
      message: 'Web search completed.',
      content: 'Street Fighter 6 patch notes were published today.',
      query: String(request.input?.query || ''),
      citations: [
        {
          url: 'https://www.streetfighter.com/6/patch-notes',
          title: 'Street Fighter 6 Patch Notes'
        }
      ],
      model: 'gpt-test-search'
    }));
    const limits = {
      ...config.getDefaultAgentGraphLimits(),
      maxToolRounds: 1,
      maxToolCalls: 3,
      maxWebSearches: 2
    };
    const graphInput: AgentGraphInput = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'What are the newest Street Fighter patch notes?' }
      ],
      textProvider,
      generationOptions: {
        maxTokens: 120
      },
      provider: {
        providerName: 'anthropic',
        model: 'claude-test',
        capabilities: textProvider.capabilities,
        hasImageProvider: true,
        hasVideoProvider: false,
        hasWebSearch: true
      },
      limits,
      intent: 'search',
      intentConfidence: 0.95,
      intentReason: 'time_sensitive_or_current_factual_trigger',
      requestedTools: [
        { name: 'web_search', input: { query: 'newest Street Fighter patch notes' } }
      ],
      toolExecutor: executor,
      metadata: {
        guildId: 'guild-1',
        channelId: 'channel-1',
        messageType: 'discord-message',
        commandName: 'message',
        provider: 'anthropic',
        model: 'claude-test',
        graphName: 'discord-message-agent',
        graphVersion: 'v2',
        intent: 'search',
        intentConfidence: 0.95,
        intentReason: 'time_sensitive_or_current_factual_trigger',
        questionType: 'searchable',
        questionCount: 1,
        searchableQuestionCount: 1,
        conversationalQuestionCount: 0,
        requestedTools: ['web_search'],
        searchProvider: 'openai',
        searchQuery: 'newest Street Fighter patch notes'
      }
    };

    const result = await telemetry.withLangfuseRootTrace(
      {
        name: 'discord.message.mention',
        traceName: 'discord.message.mention',
        sessionId: 'guild-1:channel-1',
        userId: 'hashed-user',
        metadata: metadata.buildLangfuseTraceMetadata(graphInput.metadata),
        tags: metadata.buildLangfuseTags(graphInput.metadata),
        version: 'test-prompt'
      },
      async (_rootObservation, traceId) => {
        expect(traceId).toBe('trace-e2e');
        return telemetry.withLangfuseSpan(
          {
            name: 'generate-assistant-response',
            input: { promptPreview: 'newest Street Fighter patch notes' },
            metadata: { provider: 'anthropic', temperature: 0.6 }
          },
          async observation => {
            const graphResult = await graph.runBoundedAgentGraph(graphInput);
            observation?.update({
              output: { outputCharacters: graphResult.response.content.length }
            });
            return graphResult;
          }
        );
      }
    );

    expect(result.outcome).toBe('success');
    expect(result.toolsCalled).toEqual(['web_search']);
    expect(result.citations).toEqual([
      {
        url: 'https://www.streetfighter.com/6/patch-notes',
        title: 'Street Fighter 6 Patch Notes'
      }
    ]);

    expect(observations.map(observation => observation.name)).toEqual([
      'discord.message.mention',
      'generate-assistant-response',
      'agent.ingress',
      'agent.input-safety',
      'agent.context',
      'agent.tool-planning',
      'agent.tool-execution',
      'agent.model-generation',
      'agent.output-safety',
      'agent.persistence'
    ]);

    const toolExecution = observations.find(
      observation => observation.name === 'agent.tool-execution'
    );
    const finalToolMetadata = toolExecution?.updates
      .map(update => update.metadata as Record<string, unknown> | undefined)
      .find(
        update => Array.isArray(update?.toolsCalled) && update.toolsCalled.includes('web_search')
      );

    expect(finalToolMetadata).toMatchObject({
      graphName: 'discord-message-agent',
      graphVersion: 'v2',
      graphNode: 'tool_execution',
      intent: 'search',
      intentConfidence: 0.95,
      questionType: 'searchable',
      searchableQuestionCount: 1,
      searchProvider: 'openai',
      searchQuery: 'newest Street Fighter patch notes',
      searchResultCount: 1,
      safetyState: 'allowed'
    });
    expect(finalToolMetadata?.toolsCalled).toEqual(['web_search']);
    expect(finalToolMetadata?.sourceDomains).toEqual(['streetfighter.com']);
    expect(finalToolMetadata?.toolBudget).toMatchObject({
      maxToolRounds: 1,
      maxToolCalls: 3,
      maxWebSearches: 2
    });

    const generation = observations.find(
      observation => observation.name === 'agent.model-generation'
    );
    expect(generation?.type).toBe('generation');
    expect(generation?.updates.at(-1)).toMatchObject({
      output: {
        toolResultCount: 1,
        citationCount: 1
      }
    });

    const childObservations = observations.filter(
      observation => observation.name !== 'discord.message.mention'
    );
    for (const observation of childObservations) {
      expect(
        observation.updates.some(update => Object.prototype.hasOwnProperty.call(update, 'input')),
        `${observation.name} should record sanitized input`
      ).toBe(true);
      expect(
        observation.updates.some(update => Object.prototype.hasOwnProperty.call(update, 'output')),
        `${observation.name} should record output`
      ).toBe(true);
    }

    const usageUpdateCount = observations.reduce(
      (count, observation) =>
        count +
        observation.updates.filter(update =>
          Object.prototype.hasOwnProperty.call(update, 'usageDetails')
        ).length,
      0
    );
    expect(usageUpdateCount).toBe(1);
  });
});
