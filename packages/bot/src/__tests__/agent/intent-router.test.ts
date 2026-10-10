import { describe, expect, mock, test } from 'bun:test';
import type { TextProvider } from '@silo/core';
import { routeAgentIntent } from '../../agent/intent-router';

describe('agent intent router', () => {
  test.each([
    'What are the newest Street Fighter patch notes?',
    'latest SF6 balance patch',
    'current mortgage rates',
    "today's NBA scores",
    'who is winning the NBA finals rn?',
    'How are you? Who is winning the NBA finals rn?',
    'Who is winning? When is the next game? What is the current score?',
    'Search the web for recent news',
    'find a video about the latest release',
    'write fictional patch notes for my game',
    'what is Street Fighter?',
    'summarize this URL https://example.com/patch'
  ])('never infers web search from an ordinary prompt: %s', async text => {
    const result = await routeAgentIntent({ text });
    expect(result.intent).toBe('answer');
    expect(result.requestedTools).toEqual([]);
    expect(result).not.toHaveProperty('searchableQuestionCount');
  });

  test.each(['draw a cyberpunk Ryu poster', 'generate an image of a Discord banner'])(
    'routes explicit image creation: %s',
    async prompt => {
      const result = await routeAgentIntent({ text: prompt });

      expect(result.intent).toBe('image_generate');
      expect(result.requestedTools[0]?.name).toBe('image_generation');
    }
  );

  test('routes image-only attachment turns to vision analysis instead of empty prompt clarify', async () => {
    const result = await routeAgentIntent({ text: '', hasImageAttachments: true });

    expect(result.intent).toBe('vision_analyze');
    expect(result.reason).toBe('image_only_vision_context');
    expect(result.clarificationReason).toBeUndefined();
    expect(result.requestedTools).toEqual([]);
  });

  test.each([
    'Keep this image but make its background blue.',
    'Please keep the photo and change the background to white.',
    'Use this picture but make the background green.'
  ])('routes an explicit background edit with a reference: %s', async text => {
    const result = await routeAgentIntent({ text, hasImageAttachments: true });
    expect(result.intent).toBe('image_edit');
    expect(result.requestedTools).toEqual([
      { name: 'image_generation', input: { prompt: text, action: 'edit' } }
    ]);
  });

  test.each([
    'Explain how to keep this image but make its background blue.',
    'Describe this image but make the explanation short.',
    'Keep this image but make a poem about its background.',
    'Quoted text: "Keep this image but make its background blue." Summarize it.'
  ])(
    'does not turn informational or quoted background wording into a paid edit: %s',
    async text => {
      const result = await routeAgentIntent({ text, hasImageAttachments: true });
      expect(result.requestedTools.some(tool => tool.name === 'image_generation')).toBe(false);
    }
  );

  test('requires an actual reference for background editing', async () => {
    const result = await routeAgentIntent({
      text: 'Keep this image but make its background blue.'
    });
    expect(result.requestedTools).toEqual([]);
  });

  test.each(['describe this image', 'find an image URL for Ryu', 'what image model do you use?'])(
    'does not generate images for informational image prompt: %s',
    async prompt => {
      const result = await routeAgentIntent({ text: prompt, hasImageAttachments: true });

      expect(result.requestedTools.some(tool => tool.name === 'image_generation')).toBe(false);
    }
  );

  test.each(['make a 5 second video of this scene', 'animate this attached image'])(
    'routes explicit video creation: %s',
    async prompt => {
      const result = await routeAgentIntent({ text: prompt });

      expect(result.intent).toBe('video_generate');
      expect(result.requestedTools[0]?.name).toBe('video_generation');
    }
  );

  test.each(['find a video about SF6', 'summarize this video transcript'])(
    'does not generate videos for informational video prompt: %s',
    async prompt => {
      const result = await routeAgentIntent({ text: prompt });

      expect(result.requestedTools.some(tool => tool.name === 'video_generation')).toBe(false);
    }
  );

  test('clarifies ambiguous paid actions without spending on a classifier', async () => {
    const textProvider: TextProvider = {
      name: 'openai',
      capabilities: { vision: true },
      isConfigured: () => true,
      generateText: mock(async () => ({
        content:
          '{"intent":"clarify","confidence":0.9,"reason":"ambiguous_media","clarificationReason":"Please clarify the target action."}',
        model: 'classifier'
      }))
    };

    const result = await routeAgentIntent({
      text: 'Can you make this better?',
      hasImageAttachments: true,
      textProvider,
      inputSafetyDecision: { action: 'allow', contextEligible: true, failed: false }
    });

    expect(result.intent).toBe('clarify');
    expect(result.requestedTools).toEqual([]);
    expect(textProvider.generateText).not.toHaveBeenCalled();
  });

  test.each([
    ['blocked', { action: 'block', contextEligible: false, failed: false }],
    ['failed', { action: 'allow', contextEligible: true, failed: true }],
    ['missing', undefined]
  ] as const)(
    'does not classify ambiguous %s input with a model',
    async (_label, inputSafetyDecision) => {
      const textProvider: TextProvider = {
        name: 'openai',
        capabilities: { vision: true },
        isConfigured: () => true,
        generateText: mock(async () => ({
          content: '{"intent":"image_edit"}',
          model: 'classifier'
        }))
      };

      const result = await routeAgentIntent({
        text: 'Can you make this better?',
        hasImageAttachments: true,
        textProvider,
        inputSafetyDecision
      });

      expect(result.intent).toBe('clarify');
      expect(textProvider.generateText).not.toHaveBeenCalled();
    }
  );

  test.each(['search', 'unsupported_intent'])(
    'does not accept model-selected %s as an ambiguous intent',
    async intent => {
      const textProvider: TextProvider = {
        name: 'openai',
        capabilities: { vision: true },
        isConfigured: () => true,
        generateText: mock(async () => ({
          content: JSON.stringify({ intent, confidence: 0.99 }),
          model: 'classifier'
        }))
      };

      const result = await routeAgentIntent({
        text: 'Can you make this better?',
        hasImageAttachments: true,
        textProvider,
        inputSafetyDecision: { action: 'allow', contextEligible: true, failed: false }
      });

      expect(result.intent).toBe('clarify');
      expect(result.requestedTools).toEqual([]);
    }
  );
});
