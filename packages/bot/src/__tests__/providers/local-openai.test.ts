/**
 * Tests for LocalOpenAIProvider
 */

import { describe, test, expect, mock } from 'bun:test';
import { LocalOpenAIProvider } from '../../providers/local-openai';

describe('LocalOpenAIProvider', () => {
  test('is configured with baseURL even without api key', () => {
    const provider = new LocalOpenAIProvider(undefined, 'llama3.1', 'http://localhost:11434/v1');
    expect(provider.isConfigured()).toBe(true);
  });

  test('generateText maps response and usage', async () => {
    const provider = new LocalOpenAIProvider('local', 'llama3.1', 'http://localhost:11434/v1');

    const mockCreate = mock(async () => ({
      choices: [
        {
          message: { content: 'hello world' }
        }
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12
      },
      model: 'llama3.1'
    }));

    (provider as any).client = {
      chat: {
        completions: {
          create: mockCreate
        }
      }
    };

    const result = await provider.generateText([{ role: 'user', content: 'hi' }]);

    expect(mockCreate).toHaveBeenCalled();
    expect(result.content).toBe('hello world');
    expect(result.usage?.promptTokens).toBe(5);
    expect(result.usage?.completionTokens).toBe(7);
    expect(result.model).toBe('llama3.1');
  });
});
