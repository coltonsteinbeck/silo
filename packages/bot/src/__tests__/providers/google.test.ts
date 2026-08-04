import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { GoogleImageProvider, GoogleTextProvider } from '../../providers/google';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('GoogleImageProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('throws when API key is missing', async () => {
    const provider = new GoogleImageProvider();
    await expect(provider.generateImage('draw cat')).rejects.toThrow(
      'Google provider not configured'
    );
  });

  test('returns generated image data on success', async () => {
    globalThis.fetch = mock(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      if (!url.includes('generativelanguage.googleapis.com')) {
        throw new Error(`Unexpected URL: ${url}`);
      }

      const body = JSON.parse(String(init?.body ?? '{}'));
      expect(body.contents[0].parts[0].text).toBe('draw cat');

      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Revised prompt output' },
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: 'abc123'
                  }
                }
              ]
            }
          }
        ]
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new GoogleImageProvider('google-key');
    const result = await provider.generateImage('draw cat');

    expect(result.url).toBe('data:image/png;base64,abc123');
    expect(result.revisedPrompt).toContain('Revised prompt output');
    expect(result.model).toBe('gemini-3.1-flash-image');
  });

  test('surfaces upstream API errors', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('internal error', { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const provider = new GoogleImageProvider('google-key');
    await expect(provider.generateImage('draw cat')).rejects.toThrow(
      'Google image generation failed (500)'
    );
  });

  test('enforces reference limits and skips oversized/non-image references', async () => {
    let capturedRequestBody: { contents?: Array<{ parts: unknown[] }> } | undefined;
    const oversizedImage = new Uint8Array(6 * 1024 * 1024 + 1);
    const validImage = new Uint8Array([1, 2, 3, 4]);

    const fetchSpy = mock(async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);

      if (url === 'https://example.com/ref-1.png') {
        return new Response(validImage, {
          status: 200,
          headers: { 'Content-Type': 'image/png' }
        });
      }

      if (url === 'https://example.com/ref-2.png') {
        return new Response(oversizedImage, {
          status: 200,
          headers: { 'Content-Type': 'image/png' }
        });
      }

      if (url === 'https://example.com/ref-3.txt') {
        return new Response('not image data', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }

      if (url.includes('generativelanguage.googleapis.com')) {
        capturedRequestBody = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: 'generated-image'
                    }
                  }
                ]
              }
            }
          ]
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const provider = new GoogleImageProvider('google-key');
    await provider.generateImage('draw cat', {
      referenceImages: [
        'https://example.com/ref-1.png',
        'https://example.com/ref-2.png',
        'https://example.com/ref-3.txt',
        'https://example.com/ref-4.png'
      ]
    });

    const calledUrls = fetchSpy.mock.calls.map(call => String(call[0]));
    expect(calledUrls).toContain('https://example.com/ref-1.png');
    expect(calledUrls).toContain('https://example.com/ref-2.png');
    expect(calledUrls).toContain('https://example.com/ref-3.txt');
    expect(calledUrls).not.toContain('https://example.com/ref-4.png');

    expect(capturedRequestBody).toBeDefined();
    const contents = capturedRequestBody ? capturedRequestBody.contents || [] : [];
    const parts = contents[0]?.parts || [];
    expect(parts.length).toBe(2);
  });
});

describe('GoogleTextProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('throws when API key is missing', async () => {
    const provider = new GoogleTextProvider();

    await expect(provider.generateText([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'Google provider not configured'
    );
  });

  test('sends system instruction as Content object with parts[0].text', async () => {
    let capturedRequestBody: Record<string, any> | undefined;

    globalThis.fetch = mock(async (_input: unknown, init?: { body?: unknown }) => {
      capturedRequestBody = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse({
        candidates: [
          {
            finishReason: 'MAX_TOKENS',
            content: {
              parts: [{ text: 'assistant reply' }]
            }
          }
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 2,
          totalTokenCount: 5
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new GoogleTextProvider('google-key');
    const systemInstruction = 'Always follow safety policy.';

    const result = await provider.generateText([
      { role: 'system', content: systemInstruction },
      { role: 'user', content: 'hello' }
    ]);

    expect(result.content).toBe('assistant reply');
    expect(result.finishReason).toBe('length');
    expect(result.providerFinishReason).toBe('MAX_TOKENS');
    expect(capturedRequestBody).toBeDefined();
    expect(capturedRequestBody?.system_instruction?.parts?.[0]?.text).toBe(systemInstruction);
    expect(capturedRequestBody?.contents?.[0]?.role).toBe('user');
  });

  test('applies caller-supplied temperature in generationConfig', async () => {
    let capturedRequestBody: Record<string, any> | undefined;

    globalThis.fetch = mock(async (_input: unknown, init?: { body?: unknown }) => {
      capturedRequestBody = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: 'assistant reply' }]
            }
          }
        ]
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new GoogleTextProvider('google-key');
    await provider.generateText([{ role: 'user', content: 'hello' }], { temperature: 0.35 });

    expect(capturedRequestBody?.generationConfig?.temperature).toBe(0.35);
  });

  test('surfaces upstream Gemini API errors for text generation', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('bad gateway', { status: 502 });
    }) as unknown as typeof globalThis.fetch;

    const provider = new GoogleTextProvider('google-key');
    await expect(provider.generateText([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'Google text generation failed (502): bad gateway'
    );
  });
});
