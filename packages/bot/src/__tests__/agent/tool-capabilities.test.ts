import { describe, expect, mock, test } from 'bun:test';
import {
  resolveToolCapabilities,
  toAgentProviderCapabilities
} from '../../agent/tool-capabilities';

describe('resolveToolCapabilities', () => {
  test.each([
    { video: ['xai'], expected: true },
    { video: [], expected: false }
  ])(
    'uses configured video availability independently of the text provider: $expected',
    ({ video, expected }) => {
      const registry = {
        getAvailableProviders: () => ({ text: ['openai'], image: ['openai'], video, webSearch: [] })
      };
      const result = resolveToolCapabilities({
        registry: registry as any,
        providerName: 'openai',
        capabilities: { vision: true, videoGeneration: false },
        webSearchEnabled: false
      });
      expect(result.supportsVideoGeneration).toBe(expected);
      expect(toAgentProviderCapabilities(result).hasVideoProvider).toBe(expected);
      expect(toAgentProviderCapabilities(result).hasWebSearch).toBe(false);
    }
  );

  test('enables web search when any configured search provider exists', () => {
    const registry = {
      getAvailableProviders: mock(() => ({
        text: ['xai', 'openai'],
        image: ['openai'],
        video: [],
        webSearch: ['openai']
      }))
    };

    const result = resolveToolCapabilities({
      registry: registry as any,
      providerName: 'xai',
      model: 'grok-test',
      capabilities: { vision: false },
      webSearchEnabled: true
    });

    expect(result.supportsWebSearch).toBe(true);
    expect(toAgentProviderCapabilities(result).hasWebSearch).toBe(false);
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
