/**
 * Tests for Provider Registry
 *
 * Tests provider initialization, selection, and availability checking.
 */

import { describe, test, expect, mock, spyOn } from 'bun:test';
import { QuotaMiddleware } from '../../middleware/quota';
import { ProviderRegistry, classifyTextWorkload } from '../../providers/registry';

describe('ProviderRegistry', () => {
  const createMinimalConfig = (overrides = {}) => ({
    discord: {
      token: 'a'.repeat(60),
      clientId: '123456789'
    },
    providers: {},
    database: {
      url: 'postgresql://localhost/db',
      maxConnections: 10,
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
      enableVoice: true,
      enableImages: true
    },
    security: {
      enableMonitoring: false
    },
    ...overrides
  });

  describe('constructor', () => {
    test('initializes with no providers', () => {
      const config = createMinimalConfig();
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toHaveLength(0);
      expect(available.image).toHaveLength(0);
    });

    test('initializes OpenAI provider when API key present', () => {
      const config = createMinimalConfig({
        providers: {
          openai: {
            apiKey: 'sk-test-key',
            model: 'gpt-4o-mini'
          }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toContain('openai');
      expect(available.image).toContain('openai');
    });

    test('ignores retired provider configuration', () => {
      for (const name of ['anthropic', 'google', 'local']) {
        const registry = new ProviderRegistry(
          createMinimalConfig({
            providers: {
              [name]: {
                apiKey: 'test-key',
                model: 'retired',
                baseURL: 'https://example.invalid/v1'
              }
            },
            features: { enableLocalModels: true }
          }) as any
        );
        expect(registry.getAvailableProviders()).toEqual({
          text: [],
          image: [],
          video: [],
          webSearch: []
        });
        expect(() => registry.getTextProvider(name)).toThrow('No text provider configured');
      }
    });

    test('initializes multiple providers', () => {
      const config = createMinimalConfig({
        providers: {
          openai: {
            apiKey: 'sk-openai-test',
            model: 'gpt-4o'
          },
          xai: {
            apiKey: 'sk-ant-test',
            model: 'grok-model'
          }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toContain('openai');
      expect(available.text).toContain('xai');
    });
  });

  describe('getTextProvider', () => {
    test('returns provider by name', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' },
          xai: { apiKey: 'sk-ant', model: 'grok-model' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const provider = registry.getTextProvider('xai');
      expect(provider.name).toBe('xai');
    });

    test('returns first configured provider when no name specified', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const provider = registry.getTextProvider();
      expect(provider.name).toBe('openai');
    });

    test('throws when no provider configured', () => {
      const config = createMinimalConfig();
      const registry = new ProviderRegistry(config as any);

      expect(() => registry.getTextProvider()).toThrow('No text provider configured');
    });

    test('rejects unavailable named providers without hidden substitution', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      expect(() => registry.getTextProvider('nonexistent')).toThrow('No text provider configured');
    });
  });

  describe('getImageProvider', () => {
    test('returns OpenAI for image generation', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const provider = registry.getImageProvider();
      expect(provider.name).toBe('openai');
    });

    test('throws when no image provider configured', () => {
      const config = createMinimalConfig({
        providers: {}
      });
      const registry = new ProviderRegistry(config as any);

      expect(() => registry.getImageProvider()).toThrow('No image provider configured');
    });
  });

  describe('getWebSearchProvider', () => {
    const createWebSearchProvider = (name: string, configured: boolean) => ({
      name,
      isConfigured: () => configured,
      searchWeb: async () => ({
        content: `${name} result`,
        citations: []
      })
    });

    test('returns a named configured provider and null for missing or unconfigured providers', () => {
      const registry = new ProviderRegistry(createMinimalConfig() as any);
      const unconfiguredProvider = createWebSearchProvider('openai', false);
      const configuredProvider = createWebSearchProvider('xai', true);

      (registry as any).webSearchProviders = [unconfiguredProvider, configuredProvider];

      expect(registry.getWebSearchProvider('xai')).toBe(configuredProvider);
      expect(registry.getWebSearchProvider('openai')).toBeNull();
      expect(registry.getWebSearchProvider('missing')).toBeNull();
    });

    test('returns the first configured provider or null when none are configured', () => {
      const registry = new ProviderRegistry(createMinimalConfig() as any);
      const firstProvider = createWebSearchProvider('openai', false);
      const secondProvider = createWebSearchProvider('xai', true);

      (registry as any).webSearchProviders = [firstProvider, secondProvider];
      expect(registry.getWebSearchProvider()).toBe(secondProvider);

      (registry as any).webSearchProviders = [firstProvider];
      expect(registry.getWebSearchProvider()).toBeNull();

      (registry as any).webSearchProviders = [];
      expect(registry.getWebSearchProvider()).toBeNull();
    });
  });

  describe('getAvailableProviders', () => {
    test('returns empty arrays when no providers', () => {
      const config = createMinimalConfig();
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toEqual([]);
      expect(available.image).toEqual([]);
    });

    test('returns configured providers', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' },
          xai: { apiKey: 'sk-ant', model: 'grok-model' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toHaveLength(2);
      expect(available.image).toHaveLength(2);
    });
  });
});

describe('automatic text workloads', () => {
  test('complex defaults exclude persona routing when workload routes are absent', () => {
    const registry = new ProviderRegistry({
      providers: {
        openai: { apiKey: 'test', model: 'default' },
        xai: { apiKey: 'test', model: 'xai-default' }
      },
      features: { enableRAG: false }
    } as any);
    const persona = { textProvider: 'xai', textModel: 'persona-model' };
    const complex = registry.getTextRoute('complex', persona);
    expect(complex.provider.name).toBe('openai');
    expect(complex.options.model).toBe('default');
    const routine = registry.getTextRoute('routine', persona);
    expect(routine.provider.name).toBe('xai');
    expect(routine.options.model).toBe('persona-model');
  });

  test('preserves ordinary model-only persona and explicit request overrides', async () => {
    const registry = new ProviderRegistry({
      providers: { openai: { apiKey: 'test', model: 'default' } },
      features: { enableRAG: false }
    } as any);
    expect(registry.getTextRoute('routine', { textModel: 'persona-model' }).options.model).toBe(
      'persona-model'
    );
    const generate = mock(async (_messages: unknown, options: any) => ({
      content: 'answer',
      model: options.model
    }));
    registry.getTextProvider('openai').generateText = generate;
    const complex = registry.getTextRoute('complex', { textModel: 'persona-model' });
    expect(complex.options.model).toBe('default');
    expect((await complex.provider.generateText([], { model: 'explicit-request' })).model).toBe(
      'explicit-request'
    );
  });

  const route = (model: string, effort = 'none') => ({ provider: 'openai', model, effort });
  const config = {
    providers: {
      openai: { apiKey: 'test', model: 'default' },
      xai: { apiKey: 'test', model: 'alternate' }
    },
    features: { enableRAG: false },
    textRouting: {
      routine: route('routine'),
      analysis: route('analysis', 'low'),
      complex: route('complex', 'high'),
      summary: route('summary'),
      extraction: route('extraction')
    }
  };
  test('selects configured workload models and reasoning without mutating shared clients', () => {
    const registry = new ProviderRegistry(config as any);
    for (const role of ['routine', 'analysis', 'complex', 'summary', 'extraction'] as const) {
      expect(registry.getTextRoute(role).options.model).toBe(role);
    }
    expect(registry.getTextRoute('complex').options.reasoning).toEqual({ effort: 'high' });
    expect(registry.getConfiguredTextModel('openai')).toBe('default');
  });
  test('retains persona route for ordinary conversation and uses explicit complex role', () => {
    const registry = new ProviderRegistry(config as any);
    const persona = { textProvider: 'xai', textModel: 'persona-model' };
    expect(registry.getTextRoute('routine', persona).options.model).toBe('persona-model');
    expect(registry.getTextRoute('complex', persona).provider.name).toBe('openai');
    expect(registry.getTextRoute('complex', persona).options.model).toBe('complex');
  });
  test('cannot downgrade a configured complex role when its provider is unavailable', () => {
    expect(
      () => new ProviderRegistry({ ...config, providers: { xai: config.providers.xai } } as any)
    ).toThrow('No text provider configured');
  });
  test('classifies ordinary, analytical and explicitly complex requests without another API call', () => {
    expect(classifyTextWorkload('hello there')).toBe('routine');
    expect(classifyTextWorkload('Compare these two options')).toBe('analysis');
    expect(classifyTextWorkload('Give me a thorough architecture review')).toBe('complex');
  });
});

test.each([
  [
    'Draft a 200-word proposal comparing two fictional database migration strategies, including rollback tradeoffs.',
    'complex'
  ],
  ['Please write a report on the migration results.', 'complex'],
  ['Compose a proposal for a community garden.', 'complex'],
  ['Write a one-line thank-you note.', 'routine'],
  ['What does "draft a proposal" mean?', 'routine']
] as const)(
  'classifies structured writing without upgrading incidental references: %s',
  (prompt, expected) => {
    expect(classifyTextWorkload(prompt)).toBe(expected);
  }
);

describe('bounded text availability fallback', () => {
  function quotaContext(limit = 20000) {
    const rows = new Map<string, any>();
    const db = {
      getUserRole: async () => null,
      reserveQuotaUsage: async (request: any) => {
        const held = [...rows.values()].reduce(
          (total, row) => total + (row.actualAmount ?? row.reservedAmount),
          0
        );
        const row = {
          ...request,
          status: 'reserved',
          allowed: held + request.requestedAmount <= limit,
          reservedAmount: request.requestedAmount,
          actualAmount: null,
          remaining: limit - held,
          userLimit: limit,
          guildLimit: limit,
          reason: 'quota_exceeded'
        };
        if (row.allowed) rows.set(request.idempotencyKey, row);
        return row;
      },
      markQuotaUsageAttempted: async (key: string) =>
        Object.assign(rows.get(key), { status: 'attempted' }),
      recordQuotaUsageActual: async (key: string, amount: number) => {
        rows.get(key).actualAmount = amount;
      },
      commitQuotaUsage: async (key: string, amount: number) =>
        Object.assign(rows.get(key), { status: 'committed', actualAmount: amount })
    };
    return {
      rows,
      context: {
        middleware: new QuotaMiddleware(
          db as any,
          { getUserRoleTier: async () => 'member' } as any
        ),
        operationKey: 'test-turn',
        guildId: 'guild',
        userId: 'user',
        member: {} as any,
        usageType: 'text_tokens' as const
      }
    };
  }
  function setup(error?: Error) {
    const route = { provider: 'openai', model: 'primary', effort: 'none' };
    const registry = new ProviderRegistry({
      providers: {
        openai: { apiKey: 'test' },
        xai: { apiKey: 'test' }
      },
      features: { enableRAG: false },
      textRouting: {
        routine: route,
        analysis: route,
        complex: route,
        summary: route,
        extraction: route,
        fallback: { provider: 'xai', model: 'fallback', effort: 'low', maxTokens: 200 }
      }
    } as any);
    const primary = mock(async () => {
      if (error) throw error;
      return { content: 'Cannot help', model: 'primary', finishReason: 'content_filter' as const };
    });
    const fallback = mock(async (_messages: unknown, _options?: unknown) => ({
      content: 'Available answer',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      model: 'fallback'
    }));
    registry.getTextProvider('openai').generateText = primary;
    registry.getTextProvider('xai').generateText = fallback;
    return { registry, primary, fallback };
  }
  test('starts a fresh deadline for each invocation and composes caller cancellation', async () => {
    const deadlines: AbortController[] = [];
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    try {
      const { registry, primary } = setup();
      const route = registry.getTextRoute('routine');
      expect(deadlines).toHaveLength(0);
      const caller = new AbortController();
      await route.provider.generateText([], { signal: caller.signal });
      const first = (primary.mock.calls[0] as unknown as [unknown, { signal: AbortSignal }])[1]
        .signal;
      expect(first).not.toBe(caller.signal);
      caller.abort();
      expect(first.aborted).toBe(true);
      await route.provider.generateText([]);
      const second = (primary.mock.calls[1] as unknown as [unknown, { signal: AbortSignal }])[1]
        .signal;
      expect(second).not.toBe(first);
      expect(second.aborted).toBe(false);
      deadlines[1]!.abort();
      expect(second.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  test('performs one explicit fallback for an availability failure', async () => {
    const { registry, primary, fallback } = setup(
      Object.assign(new Error('Unavailable'), { status: 503 })
    );
    const { context, rows } = quotaContext();
    const route = registry.getTextRoute('routine', undefined, context);
    expect((await route.provider.generateText([], { maxTokens: 16000 })).model).toBe('fallback');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback.mock.calls[0]?.[1]).toMatchObject({
      model: 'fallback',
      maxTokens: 200,
      reasoning: { effort: 'low' }
    });
    expect([...rows.values()]).toMatchObject([
      { status: 'attempted', reservedAmount: 16000, actualAmount: null },
      { status: 'committed', reservedAmount: 200, actualAmount: 20 }
    ]);
  });
  test('retains ambiguous primary quota and denies an unaffordable fallback', async () => {
    const { registry, primary, fallback } = setup(
      Object.assign(new Error('Unavailable'), { status: 503 })
    );
    const { context, rows } = quotaContext(400);
    await expect(
      registry.getTextRoute('routine', undefined, context).provider.generateText([])
    ).rejects.toThrow('Text quota reservation denied');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect([...rows.values()]).toMatchObject([
      { status: 'attempted', reservedAmount: 400, actualAmount: null }
    ]);
  });
  test('settles successful missing usage conservatively', async () => {
    const { registry } = setup();
    const { context, rows } = quotaContext();
    await registry.getTextRoute('routine', undefined, context).provider.generateText([]);
    expect([...rows.values()]).toMatchObject([
      { status: 'committed', reservedAmount: 400, actualAmount: 400 }
    ]);
  });
  test('does not enable paid fallback without atomic quota admission', async () => {
    const { registry, fallback } = setup(Object.assign(new Error('Unavailable'), { status: 503 }));
    await expect(registry.getTextRoute('routine').provider.generateText([])).rejects.toThrow(
      'Unavailable'
    );
    expect(fallback).not.toHaveBeenCalled();
  });
  test('does not hop providers on refusal, authentication or invalid requests', async () => {
    const refusal = setup();
    expect(
      (await refusal.registry.getTextRoute('routine').provider.generateText([])).finishReason
    ).toBe('content_filter');
    expect(refusal.fallback).not.toHaveBeenCalled();
    for (const status of [400, 401, 403]) {
      const { registry, fallback } = setup(Object.assign(new Error('Rejected'), { status }));
      await expect(registry.getTextRoute('routine').provider.generateText([])).rejects.toThrow(
        'Rejected'
      );
      expect(fallback).not.toHaveBeenCalled();
    }
  });
  test('never downgrades complex work or retries a cancelled request', async () => {
    const { registry, primary, fallback } = setup(
      Object.assign(new Error('Unavailable'), { status: 503 })
    );
    await expect(registry.getTextRoute('complex').provider.generateText([])).rejects.toThrow(
      'Unavailable'
    );
    expect(fallback).not.toHaveBeenCalled();
    primary.mockClear();
    await expect(
      registry.getTextRoute('routine').provider.generateText([], { signal: AbortSignal.abort() })
    ).rejects.toThrow();
    expect(primary).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});
