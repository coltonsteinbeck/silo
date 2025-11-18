import { ConfigSchema, type Config } from './schema';

export class ConfigLoader {
  static load(): Config {
    const rawConfig = {
      discord: {
        token: process.env.DISCORD_TOKEN,
        clientId: process.env.DISCORD_CLIENT_ID,
        guildId: process.env.DISCORD_GUILD_ID,
      },
      providers: {
        openai: process.env.OPENAI_API_KEY ? {
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        } : undefined,
        anthropic: process.env.ANTHROPIC_API_KEY ? {
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        } : undefined,
        xai: process.env.XAI_API_KEY ? {
          apiKey: process.env.XAI_API_KEY,
          model: process.env.XAI_MODEL || 'grok-beta',
        } : undefined,
        google: process.env.GOOGLE_API_KEY ? {
          apiKey: process.env.GOOGLE_API_KEY,
          model: process.env.GOOGLE_MODEL || 'gemini-2.0-flash-exp',
        } : undefined,
      },
      database: {
        url: process.env.DATABASE_URL || 'postgresql://silo:silo_dev@localhost:5432/silo',
        maxConnections: process.env.DB_MAX_CONNECTIONS ? parseInt(process.env.DB_MAX_CONNECTIONS) : 10,
        ssl: process.env.DB_SSL === 'true',
      },
      redis: {
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        maxRetries: 3,
      },
      rateLimits: {
        commandsPerUser: parseInt(process.env.RATE_LIMIT_COMMANDS_PER_USER || '10'),
        aiRequestsPerGuild: parseInt(process.env.RATE_LIMIT_AI_REQUESTS_PER_GUILD || '50'),
        voiceSessionsPerGuild: parseInt(process.env.RATE_LIMIT_VOICE_SESSIONS_PER_GUILD || '3'),
      },
      features: {
        enableRAG: process.env.ENABLE_RAG === 'true',
        enableLocalModels: process.env.ENABLE_LOCAL_MODELS === 'true',
        enableVoice: process.env.ENABLE_VOICE !== 'false',
        enableImages: process.env.ENABLE_IMAGES !== 'false',
      },
      mlService: process.env.ENABLE_ML_SERVICE === 'true' ? {
        url: process.env.ML_SERVICE_URL || 'http://localhost:8000',
        timeout: parseInt(process.env.ML_SERVICE_TIMEOUT || '30000'),
        enabled: true,
      } : undefined,
      security: {
        healthCheckSecret: process.env.HEALTH_CHECK_SECRET,
        alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
        enableMonitoring: process.env.ENABLE_MONITORING === 'true',
      },
    };

    const result = ConfigSchema.safeParse(rawConfig);
    
    if (!result.success) {
      console.error('Configuration validation failed:');
      console.error(result.error.format());
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
