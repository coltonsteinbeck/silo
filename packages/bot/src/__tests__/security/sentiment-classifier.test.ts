import { afterEach, describe, expect, test } from 'bun:test';
import { withEnv } from '@silo/core/test-setup';
import {
  sentimentClassifier,
  buildSentimentStyleInstruction,
  shouldApplySentiment,
  resetSentimentRuntimeForTests,
  setSentimentRuntimeForTests,
  isSentimentEnabled
} from '../../security/sentiment-classifier';

describe('sentiment-classifier', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    resetSentimentRuntimeForTests();
  });

  test('is enabled by default', () => {
    cleanup = withEnv({ SENTIMENT_ENABLED: undefined });
    expect(isSentimentEnabled()).toBe(true);
  });

  test('falls back to heuristic when AI is unavailable', async () => {
    cleanup = withEnv({
      SENTIMENT_ENABLED: 'true',
      SENTIMENT_MODE: 'hybrid',
      OPENAI_API_KEY: undefined
    });

    const result = await sentimentClassifier.classifyPrompt(
      'I am frustrated and confused, this is urgent and annoying.'
    );

    expect(result).not.toBeNull();
    expect(result?.source).toBe('heuristic');
    expect((result?.frustration || 0) > 0).toBe(true);
  });

  test('uses AI override when available', async () => {
    cleanup = withEnv({
      SENTIMENT_ENABLED: 'true',
      SENTIMENT_MODE: 'hybrid',
      OPENAI_API_KEY: 'test-key',
      SENTIMENT_PROMPT_FAST_PATH: 'false'
    });

    setSentimentRuntimeForTests({
      classifyWithAi: async () => ({
        label: 'negative',
        score: -0.6,
        confidence: 0.87,
        urgency: 0.5,
        frustration: 0.8,
        confusion: 0.3,
        source: 'ai'
      })
    });

    const result = await sentimentClassifier.classifyPrompt('This is not working');

    expect(result?.source).toBe('ai');
    expect(result?.confidence).toBe(0.87);
    expect(shouldApplySentiment(result || null)).toBe(true);
  });

  test('uses heuristic fast path for short prompt traffic even when AI is available', async () => {
    cleanup = withEnv({
      SENTIMENT_ENABLED: 'true',
      SENTIMENT_MODE: 'hybrid',
      OPENAI_API_KEY: 'test-key'
    });

    let aiCalls = 0;
    setSentimentRuntimeForTests({
      classifyWithAi: async () => {
        aiCalls += 1;
        return {
          label: 'positive',
          score: 0.5,
          confidence: 0.9,
          urgency: 0,
          frustration: 0,
          confusion: 0,
          source: 'ai'
        };
      }
    });

    const result = await sentimentClassifier.classifyPrompt('hail caesar');

    expect(result?.source).toBe('heuristic');
    expect(aiCalls).toBe(0);
  });

  test('still uses AI for longer ambiguous prompts when fast path does not apply', async () => {
    cleanup = withEnv({
      SENTIMENT_ENABLED: 'true',
      SENTIMENT_MODE: 'hybrid',
      OPENAI_API_KEY: 'test-key'
    });

    let aiCalls = 0;
    setSentimentRuntimeForTests({
      classifyWithAi: async () => {
        aiCalls += 1;
        return {
          label: 'neutral',
          score: 0,
          confidence: 0.82,
          urgency: 0.1,
          frustration: 0.1,
          confusion: 0.2,
          source: 'ai'
        };
      }
    });

    const result = await sentimentClassifier.classifyPrompt(
      'I want to understand how you should respond to nuanced requests across several cases where the tone is not obvious and the intent is mixed.'
    );

    expect(result?.source).toBe('ai');
    expect(aiCalls).toBe(1);
  });

  test('times out AI path and falls back to heuristic', async () => {
    cleanup = withEnv({
      SENTIMENT_ENABLED: 'true',
      SENTIMENT_MODE: 'hybrid',
      OPENAI_API_KEY: 'test-key',
      SENTIMENT_TIMEOUT_MS: '150'
    });

    setSentimentRuntimeForTests({
      classifyWithAi: async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return {
          label: 'negative',
          score: -0.5,
          confidence: 0.9,
          urgency: 0.6,
          frustration: 0.7,
          confusion: 0.2,
          source: 'ai'
        };
      }
    });

    const result = await sentimentClassifier.classifyPrompt('I am angry');

    expect(result?.source).toBe('heuristic');
  });

  test('builds soft style instruction only when confidence threshold passes', () => {
    cleanup = withEnv({ SENTIMENT_MIN_CONFIDENCE: '0.6' });

    const low = buildSentimentStyleInstruction({
      label: 'negative',
      score: -0.4,
      confidence: 0.4,
      urgency: 0.2,
      frustration: 0.2,
      confusion: 0.2,
      source: 'heuristic'
    });
    const high = buildSentimentStyleInstruction({
      label: 'negative',
      score: -0.7,
      confidence: 0.9,
      urgency: 0.8,
      frustration: 0.8,
      confusion: 0.7,
      source: 'ai'
    });

    expect(low).toBe('');
    expect(high).toContain('Response tone rule');
    expect(high).toContain('Acknowledge frustration briefly');
  });
});
