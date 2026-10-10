import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { OpenAIProvider, toOpenAIImageSize } from '../../providers/openai';

describe('toOpenAIImageSize', () => {
  test('returns each valid size unchanged', () => {
    const validSizes = [
      '256x256',
      '512x512',
      '1024x1024',
      '1024x1536',
      '1536x1024',
      'auto'
    ] as const;

    for (const size of validSizes) {
      expect(toOpenAIImageSize(size)).toBe(size);
    }
  });

  test('returns default size for invalid/undefined inputs', () => {
    expect(toOpenAIImageSize(undefined)).toBe('1024x1024');
    expect(toOpenAIImageSize('bad-size')).toBe('1024x1024');
  });
});

describe('OpenAIProvider capabilities', () => {
  test('exposes expected vision capabilities', () => {
    const provider = new OpenAIProvider();

    expect(provider.capabilities).toBeDefined();
    expect(provider.capabilities).toStrictEqual({
      vision: true,
      maxImagesPerRequest: 1,
      maxImageReferences: 5
    });
  });
});

describe('OpenAIProvider.generateImage error handling', () => {
  let provider: OpenAIProvider;
  let consoleErrorSpy: ReturnType<typeof mock>;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    provider = new OpenAIProvider('sk-test');
    consoleErrorSpy = mock(() => {});
    originalConsoleError = console.error;
    console.error = consoleErrorSpy as any;
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  test('redacts secrets in thrown error messages and logs', async () => {
    const fakeSecret = 'sk-super-secret-123';
    const fakeBearer = 'Bearer token-value-123';
    const fakeXai = 'xai-sensitive-token';

    (provider as any).client = {
      images: {
        generate: mock(async () => {
          throw new Error(`boom ${fakeSecret} ${fakeBearer} ${fakeXai}`);
        })
      }
    };

    let thrownMessage = '';
    try {
      await provider.generateImage('draw cat');
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
    }

    const loggedOutput = consoleErrorSpy.mock.calls
      .flatMap(call => call.map(part => String(part)))
      .join(' ');

    expect(thrownMessage).toContain('OpenAI image generation failed:');
    expect(thrownMessage).toContain('[redacted-key]');
    expect(thrownMessage).toContain('Bearer [redacted-token]');
    expect(thrownMessage).not.toContain(fakeSecret);
    expect(thrownMessage).not.toContain(fakeBearer);
    expect(thrownMessage).not.toContain(fakeXai);

    expect(loggedOutput).toContain('[redacted-key]');
    expect(loggedOutput).toContain('Bearer [redacted-token]');
    expect(loggedOutput).not.toContain(fakeSecret);
    expect(loggedOutput).not.toContain(fakeBearer);
    expect(loggedOutput).not.toContain(fakeXai);
  });

  test('throws on malformed image response payload', async () => {
    (provider as any).client = {
      images: {
        generate: mock(async () => ({ data: [] }))
      }
    };

    await expect(provider.generateImage('draw cat')).rejects.toThrow(
      'OpenAI image generation failed: No image data from OpenAI'
    );
  });

  test('throws when response has no url and no base64 data', async () => {
    (provider as any).client = {
      images: {
        generate: mock(async () => ({ data: [{}] }))
      }
    };

    await expect(provider.generateImage('draw cat')).rejects.toThrow(
      'OpenAI image generation failed: No image URL from OpenAI'
    );
  });
});

describe('OpenAIProvider image editing', () => {
  test('sends bounded reference files to Images edits with retries disabled', async () => {
    const provider = new OpenAIProvider('sk-test');
    const edit = mock(async (_body: unknown, _options?: unknown) => ({
      data: [{ b64_json: 'edited-image' }]
    }));
    (provider as any).client = { images: { edit } };
    const result = await provider.generateImage('make blue', {
      referenceImages: ['data:image/png;base64,aGVsbG8=']
    });
    expect(result.url).toBe('data:image/png;base64,edited-image');
    expect(edit.mock.calls[0]?.[0]).toMatchObject({ prompt: 'make blue', n: 1 });
    expect(edit.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
  });
  test.each(['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2'])(
    'sends input fidelity only for supported models: %s',
    async model => {
      const provider = new OpenAIProvider('sk-test');
      const edit = mock(async (_body: unknown) => ({ data: [{ b64_json: 'edited-image' }] }));
      (provider as any).client = { images: { edit } };
      await provider.generateImage('make blue', {
        model,
        inputFidelity: 'high',
        referenceImages: ['data:image/png;base64,aGVsbG8=']
      });
      const body = edit.mock.calls[0]?.[0] as Record<string, unknown>;
      if (model === 'gpt-image-2') expect(body).not.toHaveProperty('input_fidelity');
      else expect(body.input_fidelity).toBe('high');
    }
  );
  test('does not submit unsafe reference URLs or retry ambiguous provider failures', async () => {
    const provider = new OpenAIProvider('sk-test');
    const edit = mock(async () => {
      throw new Error('timeout');
    });
    (provider as any).client = { images: { edit } };
    await expect(
      provider.generateImage('edit', { referenceImages: ['http://127.0.0.1/secret'] })
    ).rejects.toThrow();
    expect(edit).not.toHaveBeenCalled();
    await expect(
      provider.generateImage('edit', { referenceImages: ['data:image/png;base64,aGVsbG8='] })
    ).rejects.toThrow('timeout');
    expect(edit).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAIProvider.generateText Responses contract', () => {
  function setup(response: Record<string, unknown> = {}) {
    const provider = new OpenAIProvider('sk-test');
    const create = mock(async (_body: Record<string, unknown>, _options?: unknown) => ({
      status: 'completed',
      model: 'text-model',
      output_text: 'hello',
      output: [],
      ...response
    }));
    (provider as any).client = { responses: { create } };
    return { provider, create };
  }

  test('uses the constructor default with omitted reasoning and no sampling parameter', async () => {
    const { provider, create } = setup();
    await provider.generateText([{ role: 'user', content: 'hello' }], { temperature: 0.7 });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ model: 'gpt-6-luna' });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
  });

  test('preserves constructor and per-request model overrides', async () => {
    const { create } = setup();
    const provider = new OpenAIProvider('sk-test', 'configured-model');
    (provider as any).client = { responses: { create } };
    await provider.generateText([]);
    await provider.generateText([], { model: 'request-model' });
    expect(create.mock.calls.map(call => call[0].model)).toEqual([
      'configured-model',
      'request-model'
    ]);
  });

  test.each([
    [2000, 'low'],
    [2001, 'medium'],
    [6000, 'medium'],
    [6001, 'high'],
    [12000, 'high'],
    [12001, 'xhigh']
  ] as const)(
    'preserves reasoning budget %s and the smaller output cap',
    async (budget, effort) => {
      const { provider, create } = setup();
      await provider.generateText([], {
        reasoning: { type: 'budgeted', budget },
        maxTokens: 1500,
        temperature: 0.8
      });
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        reasoning: { effort },
        max_output_tokens: 1500
      });
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
      expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort');
    }
  );

  test('maps enabled reasoning to medium without changing its output cap', async () => {
    const { provider, create } = setup();
    await provider.generateText([], {
      reasoning: { type: 'enabled' },
      maxTokens: 800,
      temperature: 0.8
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      reasoning: { effort: 'medium' },
      max_output_tokens: 800
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
  });

  test('preserves roles without server conversation state or implicit tools', async () => {
    const { provider, create } = setup();
    const messages = [
      { role: 'system' as const, content: 'Be concise' },
      { role: 'assistant' as const, content: 'Earlier answer' },
      { role: 'user' as const, content: 'Continue' }
    ];
    const signal = new AbortController().signal;
    const result = await provider.generateText(messages, { model: 'text-model', signal });
    expect(create.mock.calls[0]).toEqual([
      {
        model: 'text-model',
        input: messages,
        store: false,
        stream: false
      },
      { signal, maxRetries: 0 }
    ]);
    expect(result.finishReason).toBe('stop');
  });

  test('maps reasoning budget and incomplete output without sampling parameters', async () => {
    const { provider, create } = setup({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 }
      }
    });
    const result = await provider.generateText([{ role: 'user', content: 'test' }], {
      reasoning: { type: 'budgeted', budget: 5000 },
      maxTokens: 12000,
      temperature: 0.6
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      reasoning: { effort: 'medium' },
      max_output_tokens: 5000
    });
    expect(create.mock.calls[0]?.[0].temperature).toBeUndefined();
    expect(result.finishReason).toBe('length');
    expect(result.providerFinishReason).toBe('max_output_tokens');
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 3,
      reasoningTokens: 2
    });
  });

  test('supports explicit nonreasoning sampling and caps output', async () => {
    const { provider, create } = setup();
    await provider.generateText([], {
      reasoning: { effort: 'none' },
      temperature: 0.6,
      maxTokens: 50000
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      reasoning: { effort: 'none' },
      temperature: 0.6,
      max_output_tokens: 16000
    });
  });

  test('preserves refusals as content-filter results for canonical safety handling', async () => {
    const { provider } = setup({
      output_text: '',
      output: [
        { type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }
      ]
    });
    const result = await provider.generateText([]);
    expect(result.content).toBe('I cannot help with that.');
    expect(result.finishReason).toBe('content_filter');
  });

  test('does not accept failed, cancelled, pending or empty responses', async () => {
    for (const status of ['failed', 'cancelled', 'queued', 'in_progress']) {
      await expect(setup({ status }).provider.generateText([])).rejects.toThrow();
    }
    await expect(setup({ output_text: '' }).provider.generateText([])).rejects.toThrow();
  });
});

describe('OpenAI response phases', () => {
  test('delivers final text without SDK-concatenated commentary', async () => {
    const { default: OpenAI } = await import('openai');
    const provider = new OpenAIProvider('sk-test');
    (provider as any).client = new OpenAI({
      apiKey: 'sk-test',
      fetch: async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            model: 'text-model',
            output: [
              {
                type: 'message',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'I will explain.' }]
              },
              {
                type: 'message',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'Echo. Echo.' }]
              }
            ]
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    });
    expect((await provider.generateText([])).content).toBe('Echo. Echo.');
  });

  test('does not deliver commentary when no final answer exists', async () => {
    const provider = new OpenAIProvider('sk-test');
    (provider as any).client = {
      responses: {
        create: async () => ({
          status: 'completed',
          model: 'text-model',
          output_text: 'Still working.',
          output: [
            {
              type: 'message',
              phase: 'commentary',
              content: [{ type: 'output_text', text: 'Still working.' }]
            }
          ]
        })
      }
    };
    await expect(provider.generateText([])).rejects.toThrow('No response');
  });
});

describe('OpenAIProvider vision model contract', () => {
  test('preserves image input, completion caps and explicit model overrides', async () => {
    const provider = new OpenAIProvider('sk-test');
    const create = mock(async (_body: Record<string, unknown>) => ({
      choices: [{ message: { content: 'a blue square' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    }));
    (provider as any).client = { chat: { completions: { create } } };
    await provider.analyzeImage('https://example.com/image.png', 'Describe');
    const result = await provider.analyzeImage('https://example.com/image.png', 'Describe', {
      model: 'vision-override',
      maxTokens: 700
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'gpt-6-luna',
      max_completion_tokens: 500
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      model: 'vision-override',
      max_completion_tokens: 700,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }
          ]
        }
      ]
    });
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
  });
});
