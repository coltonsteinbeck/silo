import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { XAIProvider } from '../../providers/xai';

type FetchInit = Parameters<typeof globalThis.fetch>[1];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('XAIProvider.searchWeb', () => {
  test.each(['search', 'image'])(
    'preserves the %s deadline with a supplied cancellation signal',
    async kind => {
      const caller = new AbortController();
      const deadline = new AbortController();
      let signal: AbortSignal | undefined;
      const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      const previous = globalThis.fetch;
      globalThis.fetch = mock(async (_input: unknown, init?: FetchInit) => {
        signal = init?.signal ?? undefined;
        return jsonResponse(
          kind === 'image'
            ? { data: [{ url: 'https://example.com/image.png' }] }
            : { output_text: 'answer', model: 'test' }
        );
      }) as unknown as typeof fetch;
      try {
        const provider = new XAIProvider('test');
        if (kind === 'image') await provider.generateImage('scene', { signal: caller.signal });
        else await provider.searchWeb('query', { signal: caller.signal });
        expect(timeout).toHaveBeenCalledWith(kind === 'image' ? 180_000 : 30_000);
        expect(signal).not.toBe(caller.signal);
        deadline.abort();
        expect(signal?.aborted).toBe(true);
      } finally {
        globalThis.fetch = previous;
        timeout.mockRestore();
      }
    }
  );

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('uses only documented web_search tools and maps usage from output_text', async () => {
    let requestBody: Record<string, unknown> | undefined;

    globalThis.fetch = mock(async (_input: unknown, init?: FetchInit) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        output_text: 'Fresh answer',
        model: 'grok-search',
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          total_tokens: 12
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    const result = await provider.searchWeb('space news');

    expect(requestBody).toEqual({
      model: 'grok-4.20-non-reasoning',
      input: [{ role: 'user', content: 'space news' }],
      tools: [{ type: 'web_search' }],
      max_output_tokens: 1200,
      store: false,
      stream: false
    });
    expect(result).toEqual({
      content: 'Fresh answer',
      refused: false,
      searchCalls: undefined,
      citations: [],
      model: 'grok-search',
      usage: {
        promptTokens: 5,
        completionTokens: 7,
        totalTokens: 12
      }
    });
  });

  test('parses fallback output citations, honors maxResults, and uses option model fallback', async () => {
    let requestBody: Record<string, unknown> | undefined;

    globalThis.fetch = mock(async (_input: unknown, init?: FetchInit) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        output: [
          {
            content: [
              {
                text: 'Search ',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/one',
                    title: 'First source',
                    start_index: 0,
                    end_index: 6
                  },
                  {
                    type: 'url_citation',
                    url: 'https://example.com/two',
                    title: 'Second source',
                    start_index: 7,
                    end_index: 14
                  }
                ]
              },
              {
                text: 'summary'
              }
            ]
          }
        ],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 3,
          total_tokens: 5
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    const result = await provider.searchWeb('topic', {
      model: 'grok-search-beta',
      maxResults: 1
    });

    expect(requestBody).toEqual({
      model: 'grok-search-beta',
      input: [{ role: 'user', content: 'topic' }],
      tools: [{ type: 'web_search' }],
      max_output_tokens: 1200,
      store: false,
      stream: false
    });
    expect(result.content).toBe('Search summary');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/one',
        title: 'First source',
        startIndex: 0,
        endIndex: 6
      }
    ]);
    expect(result.model).toBe('grok-search-beta');
    expect(result.usage).toEqual({
      promptTokens: 2,
      completionTokens: 3,
      totalTokens: 5
    });
  });

  test('retains empty answers for typed no-evidence handling', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        output: [
          {
            content: [
              {
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/source',
                    title: 'Source'
                  }
                ]
              }
            ]
          }
        ]
      })
    ) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    expect((await provider.searchWeb('topic')).content).toBe('');
  });

  test('does not report zero usage for a partial provider response', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        output_text: 'Answer',
        usage: { input_tokens: 32, total_tokens: 151 }
      })
    ) as unknown as typeof globalThis.fetch;
    expect((await new XAIProvider('xai-key').searchWeb('topic')).usage).toBeUndefined();
  });

  test('includes separate reasoning in legacy Responses usage without double-counting modern output', async () => {
    const payloads = [
      {
        prompt_tokens: 32,
        completion_tokens: 9,
        total_tokens: 151,
        completion_tokens_details: { reasoning_tokens: 110 }
      },
      {
        input_tokens: 32,
        output_tokens: 119,
        total_tokens: 151,
        output_tokens_details: { reasoning_tokens: 110 }
      }
    ];
    globalThis.fetch = mock(async () =>
      jsonResponse({
        output_text: 'Answer',
        usage: payloads.shift()
      })
    ) as unknown as typeof globalThis.fetch;
    const provider = new XAIProvider('xai-key');
    for (let i = 0; i < 2; i++) {
      expect((await provider.searchWeb('topic')).usage).toMatchObject({
        promptTokens: 32,
        completionTokens: 119,
        totalTokens: 151
      });
    }
  });
});
