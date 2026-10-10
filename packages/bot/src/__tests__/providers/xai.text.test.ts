import { describe, expect, mock, test } from 'bun:test';
import { XAIProvider } from '../../providers/xai';

describe('XAIProvider.generateText', () => {
  for (const operation of ['text', 'vision'] as const) {
    test(`leaves partial ${operation} usage unknown for conservative quota settlement`, async () => {
      const provider = new XAIProvider('xai-key');
      (provider as any).client = {
        chat: {
          completions: {
            create: mock(async () => ({
              choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }],
              model: 'grok-test',
              usage: { prompt_tokens: 32, total_tokens: 151 }
            }))
          }
        }
      };
      const result =
        operation === 'text'
          ? await provider.generateText([{ role: 'user', content: 'Question' }])
          : await provider.analyzeImage('https://example.com/test.png', 'Describe it.');
      expect(result.usage).toBeUndefined();
    });

    test(`includes separately billed reasoning in ${operation} completion usage`, async () => {
      const provider = new XAIProvider('xai-key');
      const usage = {
        prompt_tokens: 2330,
        completion_tokens: 12,
        total_tokens: 2440,
        completion_tokens_details: { reasoning_tokens: 98 }
      };
      (provider as any).client = {
        chat: {
          completions: {
            create: mock(async () => ({
              choices: [{ message: { content: '15' }, finish_reason: 'stop' }],
              model: 'grok-test',
              usage
            }))
          }
        }
      };

      const result =
        operation === 'text'
          ? await provider.generateText([{ role: 'user', content: 'What is 7 plus 8?' }])
          : await provider.analyzeImage('https://example.com/test.png', 'Read the number.');

      expect(result.usage).toMatchObject({
        promptTokens: 2330,
        completionTokens: 110,
        totalTokens: 2440
      });
      expect(usage.completion_tokens).toBe(12);
    });
  }

  test('maps the provider finish reason and token usage', async () => {
    const provider = new XAIProvider('xai-key');
    const create = mock(async (_body: unknown, _options?: unknown) => ({
      choices: [
        {
          message: { content: 'partial response' },
          finish_reason: 'length'
        }
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 12,
        total_tokens: 20
      },
      model: 'grok-test'
    }));

    (provider as any).client = {
      chat: {
        completions: { create }
      }
    };

    const result = await provider.generateText([{ role: 'user', content: 'hello' }], {
      maxTokens: 400,
      reasoning: { effort: 'low' }
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: 'low', max_tokens: 400 });
    expect(create.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
    expect(result.finishReason).toBe('length');
    expect(result.providerFinishReason).toBe('length');
    expect(result.usage?.completionTokens).toBe(12);
  });
});
