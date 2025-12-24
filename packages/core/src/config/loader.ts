import { ConfigSchema, type Config } from './schema';

function buildDatabaseUrl(): string {
  // Honor explicit override first
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const mode = process.env.DEPLOYMENT_MODE?.toLowerCase();

  if (mode === 'production') {
    const identifier = process.env.HOSTED_DB_IDENTIFIER;
    const password = process.env.SUPABASE_PW;
    if (!identifier || !password) {
      const missing = [];
      if (!identifier) missing.push('HOSTED_DB_IDENTIFIER');
      if (!password) missing.push('SUPABASE_PW');
      throw new Error(
        `Production mode requires database configuration. Missing environment variables: ${missing.join(', ')}`
      );
    }
    const encodedPassword = encodeURIComponent(password);
    return `postgresql://postgres:${encodedPassword}@db.${identifier}:5432/postgres`;
  }

  if (mode === 'development') {
    const identifier = process.env.DEV_DB_IDENTIFIER;
    const password = process.env.SUPABASE_DEV_PW;
    if (identifier && password) {
      const encodedPassword = encodeURIComponent(password);
      return `postgresql://postgres:${encodedPassword}@db.${identifier}:5432/postgres`;
    }
  }

  // Local fallback
  return 'postgresql://silo:silo_dev@localhost:5432/silo';
}

export class ConfigLoader {
  static load(): Config {
    const rawConfig = {
      discord: {
        token: process.env.DISCORD_TOKEN,
        clientId: process.env.DISCORD_CLIENT_ID,
        guildId: process.env.DISCORD_GUILD_ID
      },
      providers: {
        openai: process.env.OPENAI_API_KEY
          ? {
              apiKey: process.env.OPENAI_API_KEY,
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
            }
          : undefined,
        anthropic: process.env.ANTHROPIC_API_KEY
          ? {
              apiKey: process.env.ANTHROPIC_API_KEY,
              model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'
            }
          : undefined,
        xai: process.env.XAI_API_KEY
          ? {
              apiKey: process.env.XAI_API_KEY,
              model: process.env.XAI_MODEL || 'grok-3-mini'
            }
          : undefined,
        local:
          process.env.LOCAL_API_KEY || process.env.LOCAL_MODEL || process.env.LOCAL_BASE_URL
            ? {
                apiKey: process.env.LOCAL_API_KEY,
                model: process.env.LOCAL_MODEL || 'llama3.1',
                baseURL: process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1'
              }
            : undefined,
        google: process.env.GOOGLE_API_KEY
          ? {
              apiKey: process.env.GOOGLE_API_KEY,
              model: process.env.GOOGLE_MODEL || 'gemini-2.0-flash-exp'
            }
          : undefined
      },
      database: {
        url: buildDatabaseUrl(),
        maxConnections: process.env.DB_MAX_CONNECTIONS
          ? parseInt(process.env.DB_MAX_CONNECTIONS)
          : 10,
        ssl: process.env.DB_SSL === 'true'
      },
      redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        maxRetries: 3
      },
      rateLimits: {
        commandsPerUser: parseInt(process.env.RATE_LIMIT_COMMANDS_PER_USER || '10'),
        aiRequestsPerGuild: parseInt(process.env.RATE_LIMIT_AI_REQUESTS_PER_GUILD || '50'),
        voiceSessionsPerGuild: parseInt(process.env.RATE_LIMIT_VOICE_SESSIONS_PER_GUILD || '3')
      },
      features: {
        enableRAG: process.env.ENABLE_RAG === 'true',
        enableLocalModels: process.env.ENABLE_LOCAL_MODELS === 'true',
        enableVoice: process.env.ENABLE_VOICE !== 'false',
        enableImages: process.env.ENABLE_IMAGES !== 'false'
      },
      mlService:
        process.env.ENABLE_ML_SERVICE === 'true'
          ? {
              url: process.env.ML_SERVICE_URL || 'http://localhost:8000',
              timeout: parseInt(process.env.ML_SERVICE_TIMEOUT || '30000'),
              enabled: true
            }
          : undefined,
      security: {
        healthCheckSecret: process.env.HEALTH_CHECK_SECRET,
        alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
        enableMonitoring: process.env.ENABLE_MONITORING === 'true'
      }
    };

    const result = ConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      console.error('\n❌ Configuration validation failed:\n');
      const formatted = result.error.format();
      console.error(JSON.stringify(formatted, null, 2));
      console.error('\nCheck your .env file for missing or invalid values.\n');
      throw new Error('Invalid configuration. Check .env file.');
    }

    return result.data;
  }

  static validate(): boolean {
    try {
      this.load();
      return true;
    } catch {
      return false;
    }
  }
}
