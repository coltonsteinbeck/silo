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

describe('OpenAIProvider.generateImage reference image path', () => {
  test('returns image data from responses.create output', async () => {
    const provider = new OpenAIProvider('sk-test');

    (provider as any).client = {
      responses: {
        create: mock(async () => ({
          output: [
            {
              type: 'image_generation_call',
              status: 'completed',
              result: 'base64-image-data',
              revised_prompt: 'revised prompt'
            }
          ]
        }))
      },
      images: {
        generate: mock(async () => {
          throw new Error('images.generate should not be called for reference-image path');
        })
      }
    };

    const result = await provider.generateImage('draw cat', {
      referenceImages: ['https://example.com/ref.png']
    });

    expect(result.url).toBe('data:image/png;base64,base64-image-data');
    expect(result.revisedPrompt).toBe('revised prompt');
    expect(result.model).toBe('gpt-image-1');
  });

  test('throws when responses.create payload is malformed', async () => {
    const provider = new OpenAIProvider('sk-test');

    (provider as any).client = {
      responses: {
        create: mock(async () => ({ output: [{ type: 'reasoning' }] }))
      }
    };

    await expect(
      provider.generateImage('draw cat', { referenceImages: ['https://example.com/ref.png'] })
    ).rejects.toThrow(
      'OpenAI image generation failed: No image output from OpenAI response tool call'
    );
  });

  test('throws when image_generation_call has no result', async () => {
    const provider = new OpenAIProvider('sk-test');

    (provider as any).client = {
      responses: {
        create: mock(async () => ({
          output: [{ type: 'image_generation_call', status: 'completed' }]
        }))
      }
    };

    await expect(
      provider.generateImage('draw cat', { referenceImages: ['https://example.com/ref.png'] })
    ).rejects.toThrow(
      'OpenAI image generation failed: No image output from OpenAI response tool call'
    );
  });
});

describe('OpenAIProvider.generateText reasoning parameters', () => {
  test('maps budgeted reasoning to effort and max_output_tokens cap', async () => {
    const provider = new OpenAIProvider('sk-test');
    const createSpy = mock(async (_request: Record<string, unknown>) => ({
      choices: [{ message: { content: 'hello' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      },
      model: 'gpt-5.4-nano'
    }));

    (provider as any).client = {
      chat: {
        completions: {
          create: createSpy
        }
      }
    };

    await provider.generateText([{ role: 'user', content: 'test' }], {
      reasoning: { type: 'budgeted', budget: 5000 },
      maxTokens: 12000
    });

    const request = createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const reasoning = request.reasoning as Record<string, unknown> | undefined;
    expect(reasoning).toEqual({ effort: 'medium' });
    expect(request.max_output_tokens).toBe(5000);
    expect(reasoning?.budget_tokens).toBeUndefined();
  });

  test('caps max_output_tokens at model limit for large reasoning budgets', async () => {
    const provider = new OpenAIProvider('sk-test');
    const createSpy = mock(async (_request: Record<string, unknown>) => ({
      choices: [{ message: { content: 'hello' } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15
      },
      model: 'gpt-5.4-nano'
    }));

    (provider as any).client = {
      chat: {
        completions: {
          create: createSpy
        }
      }
    };

    await provider.generateText([{ role: 'user', content: 'test' }], {
      reasoning: { type: 'budgeted', budget: 50000 }
    });

    const request = createSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    const reasoning = request.reasoning as Record<string, unknown> | undefined;
    expect(reasoning).toEqual({ effort: 'xhigh' });
    expect(request.max_output_tokens).toBe(16000);
  });
});
