import { describe, expect, mock, test } from 'bun:test';
import { XAIProvider } from '../../providers/xai';

describe('XAIProvider.generateText', () => {
  test('maps the provider finish reason and token usage', async () => {
    const provider = new XAIProvider('xai-key');
    const create = mock(async () => ({
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
      maxTokens: 400
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('length');
    expect(result.providerFinishReason).toBe('length');
    expect(result.usage?.completionTokens).toBe(12);
  });
});
