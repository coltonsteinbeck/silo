import { describe, expect, mock, test } from 'bun:test';
import { resolveToolCapabilities } from '../../agent/tool-capabilities';

describe('resolveToolCapabilities', () => {
  test('enables web search when any configured search provider exists', () => {
    const registry = {
      getAvailableProviders: mock(() => ({
        text: ['anthropic', 'openai'],
        image: ['openai'],
        video: [],
        webSearch: ['openai']
      }))
    };

    const result = resolveToolCapabilities({
      registry: registry as any,
      providerName: 'anthropic',
      model: 'claude-test',
      capabilities: { vision: false },
      webSearchEnabled: true
    });

    expect(result.supportsWebSearch).toBe(true);
    expect(result.webSearchProviderName).toBe('openai');
  });

  test('disables web search when the feature flag is off even if providers exist', () => {
    const registry = {
      getAvailableProviders: mock(() => ({
        text: ['openai'],
        image: ['openai'],
        video: [],
        webSearch: ['openai']
      }))
    };

    const result = resolveToolCapabilities({
      registry: registry as any,
      providerName: 'openai',
      model: 'gpt-test',
      capabilities: { vision: false },
      webSearchEnabled: false
    });

    expect(result.supportsWebSearch).toBe(false);
    expect(result.webSearchProviderName).toBeUndefined();
  });
});
