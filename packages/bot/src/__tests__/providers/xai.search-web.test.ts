import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { XAIProvider } from '../../providers/xai';

type FetchInit = Parameters<typeof globalThis.fetch>[1];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('XAIProvider.searchWeb', () => {
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
      stream: false
    });
    expect(result).toEqual({
      content: 'Fresh answer',
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

  test('throws when no answer text is returned', async () => {
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
    await expect(provider.searchWeb('topic')).rejects.toThrow(
      'xAI web search returned no answer text'
    );
  });
});
