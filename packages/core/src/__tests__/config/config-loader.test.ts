/**
 * Tests for Config Loader and Schema
 *
 * Tests configuration validation, schema parsing,
 * and error handling for invalid configurations.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { withEnv } from '../../test-setup';
import { ConfigLoader } from '../../config/loader';
import {
  ConfigSchema,
  ProviderConfigSchema,
  DatabaseConfigSchema,
  TextRoutingSchema
} from '../../config/schema';

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

    test('ignores retired provider configuration', () => {
      expect(
        ProviderConfigSchema.parse({
          anthropic: { apiKey: 'retired' },
          google: { apiKey: 'retired' },
          local: { baseURL: 'https://example.invalid/v1' }
        })
      ).toEqual({});
    });

    test('applies default model for openai', () => {
      const result = ProviderConfigSchema.safeParse({
        openai: {
          apiKey: 'sk-test'
        }
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.openai?.model).toBe('gpt-6-luna');
      }
    });

    test('accepts xai config with baseURL', () => {
      const result = ProviderConfigSchema.safeParse({
        xai: {
          apiKey: 'xai-test',
          model: 'grok-3-mini',
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

    test.each([undefined, '', 'explicit-model'])(
      'uses the OpenAI default only without an environment model: %s',
      model => {
        cleanup = withEnv({
          DISCORD_TOKEN: 'a'.repeat(60),
          DISCORD_CLIENT_ID: 'fixture-client',
          DATABASE_URL: 'postgresql://example.invalid/db',
          REDIS_URL: 'redis://example.invalid',
          OPENAI_API_KEY: 'sk-test',
          OPENAI_MODEL: model
        });
        expect(ConfigLoader.load().providers.openai?.model).toBe(model || 'gpt-6-luna');
      }
    );

    test('loads provider configs when API keys present', () => {
      cleanup = withEnv({
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        DATABASE_URL: 'postgresql://localhost/db',
        REDIS_URL: 'redis://localhost:6379',
        OPENAI_API_KEY: 'sk-test-key',
        ANTHROPIC_API_KEY: 'retired',
        GOOGLE_API_KEY: 'retired',
        LOCAL_API_KEY: 'retired',
        ENABLE_LOCAL_MODELS: 'true'
      });

      const config = ConfigLoader.load();

      expect(config.providers.openai).toBeDefined();
      expect(config.providers.openai?.apiKey).toBe('sk-test-key');
      for (const name of ['anthropic', 'google', 'local']) {
        expect(config.providers).not.toHaveProperty(name);
      }
      expect(config.features).not.toHaveProperty('enableLocalModels');
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
      expect(config.providers).not.toHaveProperty('anthropic');
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

    test('throws descriptive error for malformed connector host URL', () => {
      cleanup = withEnv({
        DEPLOYMENT_MODE: 'development',
        DEV_DB_IDENTIFIER: 'https://bad host',
        SUPABASE_DEV_PW: 'pw',
        DATABASE_URL: undefined,
        DATABASE_DEV_URL: undefined,
        DATABASE_LOCAL_URL: undefined,
        DISCORD_TOKEN: 'a'.repeat(60),
        DISCORD_CLIENT_ID: '123456789012345678',
        REDIS_URL: 'redis://localhost:6379'
      });

      expect(() => ConfigLoader.load()).toThrow('Invalid connector host/identifier');
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

describe('text model role configuration', () => {
  test('rejects incomplete roles instead of silently downgrading a workload', () => {
    expect(
      TextRoutingSchema.safeParse({ routine: { provider: 'openai', model: 'text-model' } }).success
    ).toBe(false);
  });
  test('validates each model, provider, effort and bounded output allowance', () => {
    const role = { provider: 'openai', model: 'text-model', effort: 'none', maxTokens: 400 };
    const config = {
      routine: role,
      analysis: role,
      complex: role,
      summary: role,
      extraction: role
    };
    expect(TextRoutingSchema.safeParse(config).success).toBe(true);
    for (const invalid of [
      { model: '' },
      { provider: 'unknown' },
      { effort: 'invalid' },
      { maxTokens: 16001 }
    ]) {
      expect(
        TextRoutingSchema.safeParse({ ...config, complex: { ...role, ...invalid } }).success
      ).toBe(false);
    }
  });
});
