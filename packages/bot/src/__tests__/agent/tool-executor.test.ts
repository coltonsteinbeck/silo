import { describe, expect, mock, test } from 'bun:test';
import { createProviderToolExecutor } from '../../agent/tool-executor';

describe('createProviderToolExecutor', () => {
  test('falls back to a configured web search provider when the preferred text provider cannot search', async () => {
    const searchWeb = mock(async () => ({
      content: 'The Finals are live.',
      citations: [{ url: 'https://example.com/finals', title: 'Finals live' }],
      model: 'gpt-search',
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7
      }
    }));
    const webSearchProvider = {
      name: 'openai',
      isConfigured: () => true,
      searchWeb
    };
    const getWebSearchProvider = mock((name?: string) => {
      if (name === 'anthropic') {
        return null;
      }

      if (name === 'openai' || !name) {
        return webSearchProvider as any;
      }

      return null;
    });
    const registry = {
      getWebSearchProvider,
      getConfiguredTextModel: mock((name: string) => (name === 'openai' ? 'gpt-search' : undefined))
    } as any;

    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'anthropic',
      searchFallbackProviderName: 'openai',
      textModel: 'claude-test'
    });
    const result = await executor({
      name: 'web_search',
      input: { query: 'who is winning the NBA finals rn?', maxResults: 3 }
    });

    expect(getWebSearchProvider).toHaveBeenCalledWith('anthropic');
    expect(getWebSearchProvider).toHaveBeenCalledWith('openai');
    expect(searchWeb).toHaveBeenCalledWith('who is winning the NBA finals rn?', {
      model: 'gpt-search',
      maxResults: 3
    });
    expect(result).toMatchObject({
      name: 'web_search',
      status: 'success',
      content: 'The Finals are live.',
      provider: 'openai',
      query: 'who is winning the NBA finals rn?'
    });
  });

  test('tries the configured fallback web search provider when preferred search fails', async () => {
    const failingSearchWeb = mock(async () => {
      throw new Error('upstream search unavailable');
    });
    const fallbackSearchWeb = mock(async () => ({
      content: 'Oklahoma City leads Indiana in the Finals.',
      citations: [{ url: 'https://example.com/nba-finals', title: 'NBA Finals live' }],
      model: 'gpt-search',
      usage: {
        promptTokens: 5,
        completionTokens: 8,
        totalTokens: 13
      }
    }));
    const xaiProvider = {
      name: 'xai',
      isConfigured: () => true,
      searchWeb: failingSearchWeb
    };
    const openaiProvider = {
      name: 'openai',
      isConfigured: () => true,
      searchWeb: fallbackSearchWeb
    };
    const registry = {
      getWebSearchProvider: mock((name?: string) => {
        if (name === 'xai') {
          return xaiProvider as any;
        }
        if (name === 'openai' || !name) {
          return openaiProvider as any;
        }
        return null;
      }),
      getConfiguredTextModel: mock((name: string) => (name === 'openai' ? 'gpt-search' : 'grok'))
    } as any;

    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'xai',
      searchFallbackProviderName: 'openai',
      textModel: 'grok'
    });
    const result = await executor({
      name: 'web_search',
      input: { query: 'who is winning the NBA finals?', maxResults: 5 }
    });

    expect(failingSearchWeb).toHaveBeenCalledTimes(1);
    expect(fallbackSearchWeb).toHaveBeenCalledWith('who is winning the NBA finals?', {
      model: 'gpt-search',
      maxResults: 5
    });
    expect(result).toMatchObject({
      name: 'web_search',
      status: 'success',
      provider: 'openai',
      message: 'Web search completed with openai after fallback.',
      content: 'Oklahoma City leads Indiana in the Finals.'
    });
  });

  test('prefers xAI for live sports searches when configured', async () => {
    const openaiSearchWeb = mock(async () => ({
      content: 'OpenAI schedule data is inconclusive.',
      citations: [],
      model: 'gpt-search'
    }));
    const xaiSearchWeb = mock(async () => ({
      content: 'The Knicks lead the Spurs 1-0 in the NBA Finals.',
      citations: [{ url: 'https://example.com/nba-finals', title: 'NBA Finals live' }],
      model: 'grok-search'
    }));
    const openaiProvider = {
      name: 'openai',
      isConfigured: () => true,
      searchWeb: openaiSearchWeb
    };
    const xaiProvider = {
      name: 'xai',
      isConfigured: () => true,
      searchWeb: xaiSearchWeb
    };
    const registry = {
      getWebSearchProvider: mock((name?: string) => {
        if (name === 'xai') {
          return xaiProvider as any;
        }
        if (name === 'openai' || !name) {
          return openaiProvider as any;
        }
        return null;
      }),
      getConfiguredTextModel: mock((name: string) =>
        name === 'xai' ? 'grok-search' : 'gpt-search'
      )
    } as any;

    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'openai',
      searchFallbackProviderName: 'openai',
      textModel: 'gpt-search'
    });
    const result = await executor({
      name: 'web_search',
      input: { query: 'who is winning the NBA finals?', maxResults: 5 }
    });

    expect(xaiSearchWeb).toHaveBeenCalledWith('who is winning the NBA finals?', {
      model: 'grok-search',
      maxResults: 5
    });
    expect(openaiSearchWeb).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      name: 'web_search',
      status: 'success',
      provider: 'xai',
      content: 'The Knicks lead the Spurs 1-0 in the NBA Finals.'
    });
  });

  test('falls back to the registry default video provider when the preferred provider has no video support', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://cdn.example.com/video.mp4',
      model: 'grok-imagine-video',
      moderationPassed: true
    }));
    const videoProvider = {
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    };
    const getVideoProvider = mock((name?: string) => {
      if (name === 'openai') {
        return null;
      }

      if (!name || name === 'xai') {
        return videoProvider as any;
      }

      return null;
    });
    const registry = {
      getVideoProvider,
      getConfiguredVideoModel: mock(() => 'grok-imagine-video')
    } as any;

    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'openai'
    });
    const result = await executor({
      name: 'video_generation',
      input: { prompt: 'make a sunset timelapse' }
    });

    expect(getVideoProvider).toHaveBeenCalledTimes(2);
    expect(getVideoProvider.mock.calls[0]?.[0]).toBe('openai');
    expect(getVideoProvider.mock.calls[1]?.[0]).toBeUndefined();
    expect(generateVideo).toHaveBeenCalledWith(
      'make a sunset timelapse',
      expect.objectContaining({ model: 'grok-imagine-video' })
    );
    expect(result.status).toBe('success');
  });

  test('honors an explicit video provider override before falling back', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://cdn.example.com/video.mp4',
      model: 'grok-imagine-video',
      moderationPassed: true
    }));
    const videoProvider = {
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    };
    const getVideoProvider = mock((name?: string) => {
      if (name === 'xai') {
        return videoProvider as any;
      }

      return null;
    });
    const registry = {
      getVideoProvider,
      getConfiguredVideoModel: mock(() => 'grok-imagine-video')
    } as any;

    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'openai'
    });
    const result = await executor({
      name: 'video_generation',
      input: { prompt: 'make a trailer', provider: 'xai' }
    });

    expect(getVideoProvider).toHaveBeenCalledTimes(1);
    expect(getVideoProvider).toHaveBeenCalledWith('xai');
    expect(generateVideo).toHaveBeenCalledWith(
      'make a trailer',
      expect.objectContaining({ model: 'grok-imagine-video' })
    );
    expect(result.status).toBe('success');
  });
});
