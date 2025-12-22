/**
 * Tests for Provider Registry
 *
 * Tests provider initialization, selection, and availability checking.
 */

import { describe, test, expect } from 'bun:test';
import { ProviderRegistry } from '../../providers/registry';

describe('ProviderRegistry', () => {
  const createMinimalConfig = (overrides = {}) => ({
    discord: {
      token: 'a'.repeat(60),
      clientId: '123456789'
    },
    providers: {},
    database: {
      url: 'postgresql://localhost/db',
      maxConnections: 10,
      ssl: false
    },
    redis: {
      url: 'redis://localhost:6379',
      maxRetries: 3
    },
    rateLimits: {
      commandsPerUser: 10,
      aiRequestsPerGuild: 50,
      voiceSessionsPerGuild: 3
    },
    features: {
      enableRAG: false,
      enableLocalModels: false,
      enableVoice: true,
      enableImages: true
    },
    security: {
      enableMonitoring: false
    },
    ...overrides
  });

  describe('constructor', () => {
    test('initializes with no providers', () => {
      const config = createMinimalConfig();
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toHaveLength(0);
      expect(available.image).toHaveLength(0);
    });

    test('initializes OpenAI provider when API key present', () => {
      const config = createMinimalConfig({
        providers: {
          openai: {
            apiKey: 'sk-test-key',
            model: 'gpt-4o-mini'
          }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toContain('openai');
      expect(available.image).toContain('openai');
    });

    test('initializes Anthropic provider when API key present', () => {
      const config = createMinimalConfig({
        providers: {
          anthropic: {
            apiKey: 'sk-ant-test',
            model: 'claude-3-opus'
          }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toContain('anthropic');
      // Anthropic doesn't provide image generation
      expect(available.image).not.toContain('anthropic');
    });

    test('initializes multiple providers', () => {
      const config = createMinimalConfig({
        providers: {
          openai: {
            apiKey: 'sk-openai-test',
            model: 'gpt-4o'
          },
          anthropic: {
            apiKey: 'sk-ant-test',
            model: 'claude-3-opus'
          }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toContain('openai');
      expect(available.text).toContain('anthropic');
    });
  });

  describe('getTextProvider', () => {
    test('returns provider by name', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' },
          anthropic: { apiKey: 'sk-ant', model: 'claude-3' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const provider = registry.getTextProvider('anthropic');
      expect(provider.name).toBe('anthropic');
    });

    test('returns first configured provider when no name specified', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const provider = registry.getTextProvider();
      expect(provider.name).toBe('openai');
    });

    test('throws when no provider configured', () => {
      const config = createMinimalConfig();
      const registry = new ProviderRegistry(config as any);

      expect(() => registry.getTextProvider()).toThrow('No text provider configured');
    });

    test('falls back to default when named provider not found', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      // Request nonexistent provider, should fall back
      const provider = registry.getTextProvider('nonexistent');
      expect(provider.name).toBe('openai');
    });
  });

  describe('getImageProvider', () => {
    test('returns OpenAI for image generation', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const provider = registry.getImageProvider();
      expect(provider.name).toBe('openai');
    });

    test('throws when no image provider configured', () => {
      const config = createMinimalConfig({
        providers: {
          anthropic: { apiKey: 'sk-ant', model: 'claude-3' } // No image support
        }
      });
      const registry = new ProviderRegistry(config as any);

      expect(() => registry.getImageProvider()).toThrow('No image provider configured');
    });
  });

  describe('getAvailableProviders', () => {
    test('returns empty arrays when no providers', () => {
      const config = createMinimalConfig();
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toEqual([]);
      expect(available.image).toEqual([]);
    });

    test('returns configured providers', () => {
      const config = createMinimalConfig({
        providers: {
          openai: { apiKey: 'sk-test', model: 'gpt-4o' },
          anthropic: { apiKey: 'sk-ant', model: 'claude-3' }
        }
      });
      const registry = new ProviderRegistry(config as any);

      const available = registry.getAvailableProviders();
      expect(available.text).toHaveLength(2);
      expect(available.image).toHaveLength(1); // Only OpenAI supports images
    });
  });
});
