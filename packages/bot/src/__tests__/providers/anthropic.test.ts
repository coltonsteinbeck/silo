import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { AnthropicProvider } from '../../providers/anthropic';

describe('AnthropicProvider', () => {
  let provider: AnthropicProvider;
  let createMock: ReturnType<typeof mock>;

  beforeEach(() => {
    provider = new AnthropicProvider('sk-ant-test');
    createMock = mock(async () => ({
      content: [{ type: 'text', text: 'hello world' }],
      usage: { input_tokens: 10, output_tokens: 6 },
      model: 'claude-test'
    }));

    (provider as any).client = {
      messages: {
        create: createMock
      }
    };
  });

  test('extracts and joins text from mixed content blocks', async () => {
    createMock = mock(async () => ({
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { query: 'x' } },
        { type: 'text', text: 'first segment' },
        { type: 'text', text: 'second segment' }
      ],
      usage: { input_tokens: 20, output_tokens: 8 },
      model: 'claude-test'
    }));

    (provider as any).client.messages.create = createMock;

    const result = await provider.generateText([{ role: 'user', content: 'hello' }]);

    expect(result.content).toBe('first segment\n\nsecond segment');
    expect(result.usage?.promptTokens).toBe(20);
    expect(result.usage?.completionTokens).toBe(8);
  });

  test('throws when response has no text content blocks', async () => {
    createMock = mock(async () => ({
      content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup', input: { query: 'x' } }],
      usage: { input_tokens: 20, output_tokens: 8 },
      model: 'claude-test'
    }));

    (provider as any).client.messages.create = createMock;

    await expect(provider.generateText([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'No text response from Anthropic'
    );
  });
});
