import { describe, expect, mock, test } from 'bun:test';
import type { TextProvider } from '@silo/core';
import { getDefaultAgentGraphLimits } from '../../agent/config';
import { BOUNDED_FAILURE_CONTENT, runBoundedAgentGraph } from '../../agent/bounded-graph';
import type { AgentGraphInput, AgentProviderCapabilities } from '../../agent/types';
import type { AgentToolExecutor } from '../../agent/tool-executor';
import {
  resetPromptSafetyRuntimeForTests,
  setPromptSafetyRuntimeForTests
} from '../../security/prompt-safety';

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
  test.each(['openai', 'anthropic', 'xai', 'google', 'local'])(
    'runs acyclic graph with mocked %s provider',
    async providerName => {
      const provider = {
        ...createProvider(`${providerName} response`),
        name: providerName
      };

      const result = await runBoundedAgentGraph(createInput(provider));

      expect(result.outcome).toBe('success');
      expect(result.response.content).toBe(`${providerName} response`);
      expect(result.stepCount).toBe(8);
      expect(provider.generateText).toHaveBeenCalledTimes(1);
    }
  );

  test('neutralizes mass mentions in graph output', async () => {
    const provider = createProvider('@everyone graph update for @HERE');

    const result = await runBoundedAgentGraph(createInput(provider));

    expect(result.response.content).toBe('everyone graph update for here');
    expect(result.outcome).toBe('repaired');
    expect(result.safetyState).toBe('output_repaired');
    expect(result.outputSafety).toMatchObject({
      blocked: false,
      repaired: true,
      action: 'allowed',
      outputWasReplaced: true
    });
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
      action: 'blocked',
      outputWasReplaced: true
    });
    expect(result.outputSafety?.categories).toContain('sexual/unsafe_persona');
  });

  test('uses managed output-blocked message while preserving graph block state', async () => {
    const provider = createProvider("I'm Doctor Cock. Let's examine your Cock.");

    const result = await runBoundedAgentGraph(
      createInput(provider, {
        outputBlockedMessage:
          'Nope. That one trips the wires. Rephrase it less cursed and I can help.'
      })
    );

    expect(result.outcome).toBe('blocked');
    expect(result.safetyState).toBe('output_blocked');
    expect(result.response.content).toBe(
      'Nope. That one trips the wires. Rephrase it less cursed and I can help.'
    );
    expect(result.outputSafety).toMatchObject({
      blocked: true,
      action: 'blocked',
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
          intent: 'search',
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
