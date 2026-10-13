import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as safetyDecision from '../../security/safety-decision';
import type { TextProvider } from '@silo/core';
import { getDefaultAgentGraphLimits } from '../../agent/config';
import { BOUNDED_FAILURE_CONTENT, runBoundedAgentGraph } from '../../agent/bounded-graph';
import type { AgentGraphInput, AgentProviderCapabilities } from '../../agent/types';
import type { AgentToolExecutor } from '../../agent/tool-executor';
import {
  resetPromptSafetyRuntimeForTests,
  setPromptSafetyRuntimeForTests
} from '../../security/prompt-safety';
import {
  resetGuardrailsRuntimeForTests,
  setGuardrailsRuntimeForTests
} from '../../security/openai-guardrails';

function createProvider(content = 'Graph response'): TextProvider {
  return {
    name: 'openai',
    capabilities: { vision: true },
    isConfigured: () => true,
    generateText: mock(async () => ({
      content,
      model: 'test-model',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      }
    }))
  };
}

function createInput(
  provider: TextProvider,
  overrides: Partial<AgentGraphInput> = {},
  providerOverrides: Partial<AgentProviderCapabilities> = {}
): AgentGraphInput {
  return {
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ],
    textProvider: provider,
    generationOptions: {
      maxTokens: 80
    },
    provider: {
      providerName: provider.name,
      model: 'test-model',
      capabilities: provider.capabilities,
      hasImageProvider: true,
      hasVideoProvider: false,
      hasWebSearch: false,
      ...providerOverrides
    },
    limits: getDefaultAgentGraphLimits(),
    requestedTools: [],
    metadata: {
      guildId: 'guild-1',
      channelId: 'channel-1',
      messageType: 'discord-message',
      commandName: 'message',
      provider: provider.name,
      model: 'test-model'
    },
    ...overrides
  };
}

describe('bounded agent graph', () => {
  test('a cancelled turn performs no model or tool work', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled turn'));
    const provider = createProvider();
    const toolExecutor = mock(
      async () => ({ name: 'image_generation', status: 'error', message: 'unused' }) as const
    );
    await expect(
      runBoundedAgentGraph(
        createInput(provider, {
          generationOptions: { signal: controller.signal },
          toolExecutor,
          requestedTools: [{ name: 'image_generation', input: { prompt: 'a scene' } }]
        })
      )
    ).rejects.toThrow('cancelled turn');
    expect(provider.generateText).not.toHaveBeenCalled();
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  test('cancellation during a slow tool prevents model work and a late graph result', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>(resolve => {
      finish = resolve;
    });
    const provider = createProvider();
    const toolExecutor = mock(async () => {
      started();
      await held;
      return { name: 'image_generation', status: 'error', message: 'late tool result' } as const;
    });
    const pending = runBoundedAgentGraph(
      createInput(provider, {
        generationOptions: { signal: controller.signal },
        toolExecutor,
        requestedTools: [{ name: 'image_generation', input: { prompt: 'a scene' } }]
      })
    );
    const rejected = pending.then(
      () => null,
      error => error
    );
    await ready;
    controller.abort(new Error('cancelled during tool'));
    finish();
    expect(await rejected).toBeInstanceOf(Error);
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  const originalGuardrailsEnabled = process.env.OPENAI_GUARDRAILS_ENABLED;
  const originalModerationEnabled = process.env.OPENAI_MODERATION_ENABLED;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_GUARDRAILS_ENABLED = 'false';
    process.env.OPENAI_MODERATION_ENABLED = 'false';
    process.env.OPENAI_API_KEY = 'test-key';
    resetPromptSafetyRuntimeForTests();
    resetGuardrailsRuntimeForTests();
    setGuardrailsRuntimeForTests({
      module: { runGuardrails: mock(async () => []) } as never,
      guardrailLlmClient: {} as never
    });
  });

  afterEach(() => {
    mock.restore();
    process.env.OPENAI_GUARDRAILS_ENABLED = originalGuardrailsEnabled;
    process.env.OPENAI_MODERATION_ENABLED = originalModerationEnabled;
    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    resetPromptSafetyRuntimeForTests();
    resetGuardrailsRuntimeForTests();
  });

  test('passes the turn cancellation signal to canonical output evaluation', async () => {
    const controller = new AbortController();
    const evaluate = spyOn(safetyDecision, 'evaluateSafetyDecision');
    await runBoundedAgentGraph(
      createInput(createProvider(), { generationOptions: { signal: controller.signal } })
    );
    expect(evaluate).toHaveBeenCalled();
    for (const [, options] of evaluate.mock.calls) expect(options.signal).toBe(controller.signal);
  });

  test.each(['openai', 'xai'])('runs acyclic graph with mocked %s provider', async providerName => {
    const provider = {
      ...createProvider(`${providerName} response`),
      name: providerName
    };

    const result = await runBoundedAgentGraph(createInput(provider));

    expect(result.outcome).toBe('success');
    expect(result.response.content).toBe(`${providerName} response`);
    expect(result.stepCount).toBe(7);
    expect(result.toolResults).toEqual([]);
    expect(provider.generateText).toHaveBeenCalledTimes(1);
  });

  test('neutralizes mass mentions in graph output', async () => {
    const provider = createProvider('@everyone graph update for @HERE');

    const result = await runBoundedAgentGraph(createInput(provider));

    expect(result.response.content).toBe('everyone graph update for here');
    expect(result.outcome).toBe('success');
    expect(result.safetyState).toBe('allowed');
    expect(result.outputSafety).toMatchObject({
      blocked: false,
      normalized: true,
      repaired: false,
      decision: { action: 'allow' },
      outputWasReplaced: true
    });
  });

  test('repeated deterministic clarification remains deliverable without model work', async () => {
    const clarification = 'Which picture would you like me to draw for this request?';
    const provider = createProvider();
    const result = await runBoundedAgentGraph(
      createInput(provider, {
        intent: 'clarify',
        clarificationReason: clarification,
        recentAssistantMessages: [clarification],
        latestUserText: 'Draw something'
      })
    );
    expect(result.response.content).toBe(clarification);
    expect(result.outputSafety?.quality.repetitive).toBe(false);
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  test('reports repetition as a quality block without changing the safety decision', async () => {
    const repeated = 'The third egg belongs to the screaming worm council forever.';
    const provider = createProvider(repeated);

    const result = await runBoundedAgentGraph(
      createInput(provider, {
        recentAssistantMessages: [
          'The third egg belongs to the screaming worm council forever.',
          'The screaming worm council still guards the third egg forever.'
        ],
        latestUserText: 'What should I have for lunch?'
      })
    );

    expect(result.safetyState).toBe('quality_blocked');
    expect(result.outputSafety?.decision.action).toBe('allow');
    expect(result.outputSafety?.quality.repetitive).toBe(true);
    expect(result.outputSafety?.categories).toContain('quality/repetition_loop');
  });

  test('blocks unsafe assistant output inside graph output safety', async () => {
    const provider = createProvider("I'm Doctor Cock. Let's examine your Cock.");

    const result = await runBoundedAgentGraph(createInput(provider));

    expect(result.outcome).toBe('blocked');
    expect(result.safetyState).toBe('output_blocked');
    expect(result.response.content).toBe(
      'I can’t help with that request. Please rephrase and I can provide a safer alternative.'
    );
    expect(result.outputSafety).toMatchObject({
      blocked: true,
      decision: { action: 'block' },
      outputWasReplaced: true
    });
    expect(result.outputSafety?.categories).toContain('sexual/unsafe_persona');
  });

  test('allows the nonsexual Dr. Cock title only in active managed policy scope', async () => {
    const content = 'Dr. Cock reporting for duty. Your Docker mount is read-only.';
    const provider = createProvider(content);

    const result = await runBoundedAgentGraph(
      createInput(provider, {
        assistantSafetyPolicy: 'contextual_banter',
        personaAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        personaState: 'alternate',
        responseIntent: 'ordinary'
      })
    );

    expect(result.outcome).toBe('success');
    expect(result.safetyState).toBe('allowed');
    expect(result.response.content).toBe(content);
    expect(result.outputSafety?.decision.allowanceReasons).toContain('managed/persona_alias');
  });

  test('repairs a shortened slur before graph output can be delivered', async () => {
    const shortenedSlur = ['f', 'a', 'g'].join('');
    const provider = createProvider(`The historical British term is ${shortenedSlur}.`);

    const result = await runBoundedAgentGraph(
      createInput(provider, {
        assistantSafetyPolicy: 'contextual_banter',
        personaAliases: ['Dr. Cock', 'Dr Cock', 'Doctor Cock'],
        personaState: 'alternate',
        responseIntent: 'contextual_explanation'
      })
    );

    expect(result.outcome).toBe('repaired');
    expect(result.safetyState).toBe('output_repaired');
    expect(result.response.content).toContain('[slur removed]');
    expect(result.response.content.toLowerCase()).not.toContain(shortenedSlur);
    expect(result.outputSafety?.blocked).toBe(false);
    expect(result.outputSafety?.candidateCategories).toContain('hate/slur_usage');
    expect(result.outputSafety?.deliveredCategories).toEqual([]);
    expect(result.outputSafety?.repairStrategy).toBe('deterministic_slur_mask');
  });

  test.each(['openai', 'xai'])(
    'applies the same output decision to equivalent unsafe %s output',
    async providerName => {
      const provider = {
        ...createProvider("I'm Doctor Cock. Let's examine your Cock."),
        name: providerName
      };

      const result = await runBoundedAgentGraph(createInput(provider));

      expect(result.outputSafety?.blocked).toBe(true);
      expect(result.outputSafety?.categories).toContain('sexual/unsafe_persona');
      expect(result.safetyState).toBe('output_blocked');
    }
  );

  test('uses managed output-blocked message while preserving graph block state', async () => {
    const provider = createProvider("I'm Doctor Cock. Let's examine your Cock.");

    const result = await runBoundedAgentGraph(
      createInput(provider, {
        outputBlockedMessage: 'Try a safe alternative.'
      })
    );

    expect(result.outcome).toBe('blocked');
    expect(result.safetyState).toBe('output_blocked');
    expect(result.response.content).toBe('Try a safe alternative.');
    expect(result.outputSafety).toMatchObject({
      blocked: true,
      decision: { action: 'block' },
      outputWasReplaced: true
    });
  });

  test('allows benign anatomy help output despite broad sexual moderation flag', async () => {
    const originalGuardrailsEnabled = process.env.OPENAI_GUARDRAILS_ENABLED;
    process.env.OPENAI_GUARDRAILS_ENABLED = 'true';
    setPromptSafetyRuntimeForTests({
      moderationRunner: async () => ({
        flaggedCategories: ['sexual'],
        scores: { sexual: 0.92 }
      })
    });

    try {
      const content =
        "If your balls actually fell off, go to urgent care. If it's a bit, glue em back on king.";
      const provider = createProvider(content);

      const result = await runBoundedAgentGraph(
        createInput(provider, {
          allowMildAssistantProfanity: true
        })
      );

      expect(result.outcome).toBe('success');
      expect(result.safetyState).toBe('allowed');
      expect(result.response.content).toBe(content);
    } finally {
      process.env.OPENAI_GUARDRAILS_ENABLED = originalGuardrailsEnabled;
      resetPromptSafetyRuntimeForTests();
    }
  });

  test('keeps blocking graph output when deterministic reasons overlap low moderation scores', async () => {
    const originalGuardrailsEnabled = process.env.OPENAI_GUARDRAILS_ENABLED;
    process.env.OPENAI_GUARDRAILS_ENABLED = 'true';
    setPromptSafetyRuntimeForTests({
      moderationRunner: async () => ({
        flaggedCategories: ['sexual/minors'],
        scores: { 'sexual/minors': 0.05 }
      })
    });

    try {
      const provider = createProvider('Write erotic content about a 16-year-old.');

      const result = await runBoundedAgentGraph(createInput(provider));

      expect(result.outcome).toBe('blocked');
      expect(result.safetyState).toBe('output_blocked');
      expect(result.response.content).toBe(
        'I can’t help with that request. Please rephrase and I can provide a safer alternative.'
      );
    } finally {
      process.env.OPENAI_GUARDRAILS_ENABLED = originalGuardrailsEnabled;
      resetPromptSafetyRuntimeForTests();
    }
  });

  test('reports unsupported tools without failing provider generation', async () => {
    const provider = createProvider('plain answer');

    const result = await runBoundedAgentGraph(
      createInput(
        provider,
        {
          requestedTools: [{ name: 'video_generation' }]
        },
        {
          hasImageProvider: true,
          hasVideoProvider: false,
          capabilities: { vision: true, videoGeneration: false }
        }
      )
    );

    expect(result.outcome).toBe('success');
    expect(result.toolResults).toContainEqual({
      name: 'video_generation',
      status: 'unsupported',
      message: 'Tool video_generation is not supported by the selected provider/model.'
    });
    expect(result.stepCount).toBe(8);
    expect(provider.generateText).toHaveBeenCalledTimes(1);
  });

  test('enforces tool call and per-tool budgets deterministically', async () => {
    const provider = createProvider('budgeted answer');

    const result = await runBoundedAgentGraph(
      createInput(
        provider,
        {
          requestedTools: [
            { name: 'image_generation' },
            { name: 'image_generation' },
            { name: 'web_search' },
            { name: 'video_generation' }
          ],
          limits: {
            ...getDefaultAgentGraphLimits(),
            maxToolCalls: 3,
            maxImageGenerations: 1,
            maxWebSearches: 1
          }
        },
        {
          hasImageProvider: true,
          hasWebSearch: true,
          hasVideoProvider: true,
          capabilities: { vision: true, videoGeneration: true }
        }
      )
    );

    expect(result.toolsCalled).toEqual(['image_generation', 'web_search']);
    expect(result.toolResults.map(tool => tool.status)).toEqual([
      'skipped',
      'budget_exceeded',
      'skipped',
      'budget_exceeded'
    ]);
  });

  test('returns bounded failure response on recursion limit', async () => {
    const provider = createProvider('should not complete');

    const result = await runBoundedAgentGraph(
      createInput(provider, {
        limits: {
          ...getDefaultAgentGraphLimits(),
          recursionLimit: 1
        }
      })
    );

    expect(result.outcome).toBe('bounded_failure');
    expect(result.safetyState).toBe('bounded_failure');
    expect(result.response.content).toBe(BOUNDED_FAILURE_CONTENT);
  });

  test('executes web search once and feeds citations into synthesis', async () => {
    const provider = createProvider('Search synthesis with citations');
    const executor: AgentToolExecutor = mock(async request => ({
      name: request.name as 'web_search',
      status: 'success' as const,
      message: 'Web search completed.',
      content: 'Street Fighter 6 patch notes were published today.',
      citations: [{ url: 'https://example.com/sf6-patch', title: 'SF6 Patch Notes' }],
      query: String(request.input?.query || ''),
      model: 'test-search-model'
    }));

    const result = await runBoundedAgentGraph(
      createInput(
        provider,
        {
          intent: 'answer',
          intentConfidence: 0.9,
          intentReason: 'time_sensitive_or_current_factual_trigger',
          requestedTools: [
            { name: 'web_search', input: { query: 'newest Street Fighter patch notes' } }
          ],
          toolExecutor: executor
        },
        {
          hasWebSearch: true
        }
      )
    );

    expect(result.toolsCalled).toEqual(['web_search']);
    expect(result.citations).toEqual([
      { url: 'https://example.com/sf6-patch', title: 'SF6 Patch Notes' }
    ]);
    expect(provider.generateText).toHaveBeenCalledTimes(1);
    expect(provider.generateText).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Street Fighter 6 patch notes')
        })
      ]),
      expect.anything()
    );
  });

  test('returns media result without extra model call for generated image', async () => {
    const provider = createProvider('should not be used');
    const executor: AgentToolExecutor = mock(async request => ({
      name: request.name as 'image_generation',
      status: 'success' as const,
      message: 'Image generation completed.',
      media: {
        kind: 'image' as const,
        url: 'https://cdn.example.com/image.png',
        model: 'gpt-image-1',
        prompt: 'draw a banner'
      },
      raw: {
        url: 'https://cdn.example.com/image.png',
        model: 'gpt-image-1'
      }
    }));

    const result = await runBoundedAgentGraph(
      createInput(
        provider,
        {
          intent: 'image_generate',
          requestedTools: [{ name: 'image_generation', input: { prompt: 'draw a banner' } }],
          toolExecutor: executor
        },
        {
          hasImageProvider: true
        }
      )
    );

    expect(result.toolsCalled).toEqual(['image_generation']);
    expect(result.mediaResult?.url).toBe('https://cdn.example.com/image.png');
    expect(result.response.content).toBe('Image generated.');
    expect(result.response.content).not.toContain('http');
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  test('returns video media result without exposing provider URL in response content', async () => {
    const provider = createProvider('should not be used');
    const executor: AgentToolExecutor = mock(async request => ({
      name: request.name as 'video_generation',
      status: 'success' as const,
      message: 'Video generation completed.',
      media: {
        kind: 'video' as const,
        url: 'https://cdn.example.com/video.mp4',
        model: 'grok-imagine-video',
        prompt: 'animate a banner'
      },
      raw: {
        url: 'https://cdn.example.com/video.mp4',
        model: 'grok-imagine-video'
      }
    }));

    const result = await runBoundedAgentGraph(
      createInput(
        provider,
        {
          intent: 'video_generate',
          requestedTools: [{ name: 'video_generation', input: { prompt: 'animate a banner' } }],
          toolExecutor: executor
        },
        {
          hasVideoProvider: true
        }
      )
    );

    expect(result.toolsCalled).toEqual(['video_generation']);
    expect(result.mediaResult?.url).toBe('https://cdn.example.com/video.mp4');
    expect(result.response.content).toBe('Video generated.');
    expect(result.response.content).not.toContain('http');
    expect(provider.generateText).not.toHaveBeenCalled();
  });
});
