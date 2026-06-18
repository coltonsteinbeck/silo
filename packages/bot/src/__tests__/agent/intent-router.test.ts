import { describe, expect, mock, test } from 'bun:test';
import type { TextProvider } from '@silo/core';
import { routeAgentIntent } from '../../agent/intent-router';

describe('agent intent router', () => {
  test.each([
    'What are the newest Street Fighter patch notes?',
    'latest SF6 balance patch',
    'current mortgage rates',
    "today's NBA scores",
    'who is winning the NBA finals?',
    'who is winning the NBA finals rn?',
    "who's winning the NBA Finals right now?",
    'live NBA Finals score'
  ])('routes current factual prompt to search: %s', async prompt => {
    const result = await routeAgentIntent({ text: prompt });

    expect(result.intent).toBe('search');
    expect(result.requestedTools).toContainEqual({
      name: 'web_search',
      input: { query: prompt, maxResults: 5 }
    });
  });

  test.each([
    'write fictional patch notes for my game',
    'what is Street Fighter?',
    'summarize this URL https://example.com/patch'
  ])('does not force search for stable or URL-context prompt: %s', async prompt => {
    const result = await routeAgentIntent({ text: prompt });

    expect(result.questionType).toBe('conversational');
    expect(result.requestedTools.some(tool => tool.name === 'web_search')).toBe(false);
  });

  test('marks mixed conversational and searchable turns while searching only the searchable question', async () => {
    const result = await routeAgentIntent({
      text: 'How are you? Who is winning the NBA finals rn?'
    });

    expect(result.intent).toBe('search');
    expect(result.questionType).toBe('mixed');
    expect(result.questionCount).toBe(2);
    expect(result.searchableQuestionCount).toBe(1);
    expect(result.conversationalQuestionCount).toBe(1);
    expect(result.requestedTools).toEqual([
      {
        name: 'web_search',
        input: { query: 'Who is winning the NBA finals rn', maxResults: 5 }
      }
    ]);
  });

  test('plans bounded multi-search for multiple searchable questions in one turn', async () => {
    const result = await routeAgentIntent({
      text: 'Who is winning the NBA finals rn? When is the next NBA finals game? What is the current series score?'
    });

    expect(result.intent).toBe('search');
    expect(result.questionType).toBe('searchable');
    expect(result.questionCount).toBe(3);
    expect(result.searchableQuestionCount).toBe(3);
    expect(result.requestedTools).toEqual([
      {
        name: 'web_search',
        input: { query: 'Who is winning the NBA finals rn', maxResults: 5 }
      },
      {
        name: 'web_search',
        input: { query: 'When is the next NBA finals game', maxResults: 5 }
      }
    ]);
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

  test('uses model-assisted classification for ambiguous prompts without direct tool execution', async () => {
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
      textProvider
    });

    expect(result.intent).toBe('clarify');
    expect(result.requestedTools).toEqual([]);
    expect(textProvider.generateText).toHaveBeenCalledTimes(1);
  });
});
