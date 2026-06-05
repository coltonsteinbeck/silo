import { describe, expect, mock, test } from 'bun:test';
import { OpenAIProvider } from '../../providers/openai';

describe('OpenAIProvider.searchWeb', () => {
  test('returns output_text with mapped usage and requested model', async () => {
    const provider = new OpenAIProvider('sk-test');
    let requestBody: Record<string, unknown> | undefined;
    const createSpy = mock(async (request: Record<string, unknown>) => {
      requestBody = request;
      return {
        output_text: 'Latest answer',
        model: 'gpt-5.4-search',
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18
        }
      };
    });

    (provider as any).client = {
      responses: {
        create: createSpy
      }
    };

    const result = await provider.searchWeb('latest news', { model: 'gpt-5.4-search' });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(requestBody).toEqual({
      model: 'gpt-5.4-search',
      input: 'latest news',
      tools: [{ type: 'web_search' }],
      max_output_tokens: 1200
    });
    expect(result).toEqual({
      content: 'Latest answer',
      citations: [],
      model: 'gpt-5.4-search',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18
      }
    });
  });

  test('calls responses.create with the SDK client context intact', async () => {
    const provider = new OpenAIProvider('sk-test');
    const responses = {
      expectedContext: true,
      create: mock(async function (
        this: { expectedContext?: boolean },
        _request: Record<string, unknown>
      ) {
        if (!this.expectedContext) {
          throw new Error('lost SDK context');
        }
        return {
          output_text: 'Context-bound answer',
          model: 'gpt-search'
        };
      })
    };

    (provider as any).client = { responses };

    const result = await provider.searchWeb('latest news');

    expect(responses.create).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Context-bound answer');
  });

  test('builds fallback text and citations from response output and truncates citations', async () => {
    const provider = new OpenAIProvider('sk-test');
    let requestBody: Record<string, unknown> | undefined;
    const createSpy = mock(async (request: Record<string, unknown>) => {
      requestBody = request;
      return {
        output: [
          {
            content: [
              {
                text: 'From ',
                annotations: [
                  {
                    type: 'url_citation',
                    url: 'https://example.com/one',
                    title: 'First source',
                    start_index: 0,
                    end_index: 4
                  },
                  {
                    type: 'url_citation',
                    url: 'https://example.com/two',
                    title: 'Second source',
                    start_index: 5,
                    end_index: 11
                  }
                ]
              },
              {
                text: 'search results'
              }
            ]
          }
        ],
        usage: {
          input_tokens: 4,
          output_tokens: 9,
          total_tokens: 13
        }
      };
    });

    (provider as any).client = {
      responses: {
        create: createSpy
      }
    };

    const result = await provider.searchWeb('query', { maxResults: 1 });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(requestBody).toEqual({
      model: 'gpt-5.4-nano',
      input: 'query',
      tools: [{ type: 'web_search' }],
      max_output_tokens: 1200
    });
    expect(result.content).toBe('From search results');
    expect(result.citations).toEqual([
      {
        url: 'https://example.com/one',
        title: 'First source',
        startIndex: 0,
        endIndex: 4
      }
    ]);
    expect(result.usage).toEqual({
      promptTokens: 4,
      completionTokens: 9,
      totalTokens: 13
    });
  });

  test('throws when no answer text is available', async () => {
    const provider = new OpenAIProvider('sk-test');

    (provider as any).client = {
      responses: {
        create: mock(async () => ({
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
        }))
      }
    };

    await expect(provider.searchWeb('query')).rejects.toThrow(
      'OpenAI web search returned no answer text'
    );
  });

  test('surfaces responses api failures', async () => {
    const provider = new OpenAIProvider('sk-test');

    (provider as any).client = {
      responses: {
        create: mock(async () => {
          throw new Error('responses.create failed');
        })
      }
    };

    await expect(provider.searchWeb('query')).rejects.toThrow('responses.create failed');
  });
});
