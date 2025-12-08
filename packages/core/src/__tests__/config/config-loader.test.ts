/**
 * Tests for Config Loader and Schema
 * 
 * Tests configuration validation, schema parsing,
 * and error handling for invalid configurations.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { withEnv } from '../../test-setup';
import { ConfigLoader } from '../../config/loader';
import { ConfigSchema, ProviderConfigSchema, DatabaseConfigSchema } from '../../config/schema';

describe('ConfigSchema', () => {
  describe('ProviderConfigSchema', () => {
    test('accepts empty provider config', () => {
      const result = ProviderConfigSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    test('accepts openai config with apiKey', () => {
      const result = ProviderConfigSchema.safeParse({
        openai: {
          apiKey: 'sk-test-key',
          model: 'gpt-4'
        }
      });
      expect(result.success).toBe(true);
    });

    test('accepts anthropic config', () => {
      const result = ProviderConfigSchema.safeParse({
        anthropic: {
          apiKey: 'sk-ant-test',
          model: 'claude-3-opus'
        }
      });
      expect(result.success).toBe(true);
    });

    test('applies default model for openai', () => {
      const result = ProviderConfigSchema.safeParse({
        openai: {
          apiKey: 'sk-test'
        }
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.openai?.model).toBe('gpt-4o-mini');
      }
    });

    test('accepts xai config with baseURL', () => {
      const result = ProviderConfigSchema.safeParse({
        xai: {
          apiKey: 'xai-test',
          model: 'grok-beta',
          baseURL: 'https://api.x.ai/v1'
        }
      });
      expect(result.success).toBe(true);
    });

    test('rejects invalid baseURL', () => {
      const result = ProviderConfigSchema.safeParse({
        openai: {
          apiKey: 'sk-test',
          baseURL: 'not-a-url'
        }
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DatabaseConfigSchema', () => {
    test('requires url', () => {
      const result = DatabaseConfigSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test('accepts valid database config', () => {
      const result = DatabaseConfigSchema.safeParse({
        url: 'postgresql://user:pass@localhost:5432/db'
      });
      expect(result.success).toBe(true);
    });

    test('applies default maxConnections', () => {
      const result = DatabaseConfigSchema.safeParse({
        url: 'postgresql://localhost/db'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxConnections).toBe(10);
      }
    });

    test('applies default ssl', () => {
      const result = DatabaseConfigSchema.safeParse({
        url: 'postgresql://localhost/db'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ssl).toBe(false);
      }
    });

    test('rejects negative maxConnections', () => {
      const result = DatabaseConfigSchema.safeParse({
        url: 'postgresql://localhost/db',
        maxConnections: -1
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Full ConfigSchema', () => {
    const validConfig = {
      discord: {
        token: 'a'.repeat(50), // min 50 chars
        clientId: '123456789'
      },
      providers: {},
      database: {
        url: 'postgresql://localhost/db'
      },
      redis: {
        url: 'redis://localhost:6379'
      },
      rateLimits: {},
      features: {},
      security: {}
    };

    test('accepts minimal valid config', () => {
      const result = ConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
    });

    test('rejects short discord token', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        discord: {
          token: 'short',
          clientId: '123'
        }
      });
      expect(result.success).toBe(false);
    });

    test('rejects missing clientId', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        discord: {
          token: 'a'.repeat(50)
        }
      });
      expect(result.success).toBe(false);
    });

    test('accepts optional guildId', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        discord: {
          ...validConfig.discord,
          guildId: '987654321'
        }
      });
      expect(result.success).toBe(true);
    });

    test('applies feature defaults', () => {
      const result = ConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.features.enableRAG).toBe(false);
        expect(result.data.features.enableLocalModels).toBe(false);
        expect(result.data.features.enableVoice).toBe(true);
        expect(result.data.features.enableImages).toBe(true);
      }
    });

    test('applies rate limit defaults', () => {
      const result = ConfigSchema.safeParse(validConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rateLimits.commandsPerUser).toBe(10);
        expect(result.data.rateLimits.aiRequestsPerGuild).toBe(50);
        expect(result.data.rateLimits.voiceSessionsPerGuild).toBe(3);
      }
    });

    test('accepts mlService config', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        mlService: {
          url: 'http://localhost:8000',
          timeout: 30000,
          enabled: true
        }
      });
      expect(result.success).toBe(true);
    });

    test('rejects invalid mlService url', () => {
      const result = ConfigSchema.safeParse({
        ...validConfig,
        mlService: {
          url: 'not-a-url',
          enabled: true
        }
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('ConfigLoader', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  describe('load', () => {
    test('loads valid configuration from environment', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
        REDIS_URL: 'redis://localhost:6379'
      });

      const config = ConfigLoader.load();

      expect(config.discord.token).toBe('a'.repeat(60));
      expect(config.discord.clientId).toBe('123456789012345678');
      expect(config.database.url).toBe('postgresql://user:pass@localhost:5432/testdb');
    });

    test('throws on missing required fields', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: undefined,
        DISCORD_CLIENT_ID: undefined
      });

      expect(() => ConfigLoader.load()).toThrow();
    });

    test('loads provider configs when API keys present', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        OPENAI_API_KEY: 'sk-test-key',
        ANTHROPIC_API_KEY: 'sk-ant-test'
      });

      const config = ConfigLoader.load();

      expect(config.providers.openai).toBeDefined();
      expect(config.providers.openai?.apiKey).toBe('sk-test-key');
      expect(config.providers.anthropic).toBeDefined();
      expect(config.providers.anthropic?.apiKey).toBe('sk-ant-test');
    });

    test('skips provider when API key not present', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined
      });

      const config = ConfigLoader.load();

      expect(config.providers.openai).toBeUndefined();
      expect(config.providers.anthropic).toBeUndefined();
    });

    test('parses feature flags correctly', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        ENABLE_RAG: 'true',
        ENABLE_VOICE: 'false',
        ENABLE_IMAGES: 'true'
      });

      const config = ConfigLoader.load();

      expect(config.features.enableRAG).toBe(true);
      expect(config.features.enableVoice).toBe(false);
      expect(config.features.enableImages).toBe(true);
    });

    test('parses numeric rate limits', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        RATE_LIMIT_COMMANDS_PER_USER: '20',
        RATE_LIMIT_AI_REQUESTS_PER_GUILD: '100'
      });

      const config = ConfigLoader.load();

      expect(config.rateLimits.commandsPerUser).toBe(20);
      expect(config.rateLimits.aiRequestsPerGuild).toBe(100);
    });
  });

  describe('validate', () => {
    test('returns true for valid config', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379'
      });

      expect(ConfigLoader.validate()).toBe(true);
    });

    test('returns false for invalid config', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'short',
        DISCORD_CLIENT_ID: undefined
      });

      expect(ConfigLoader.validate()).toBe(false);
    });
  });
});
