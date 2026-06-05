import { ConfigSchema, type Config } from './schema';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger';

let envLoaded = false;

function findEnvFile(startDir: string): string | undefined {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, '.env');
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function loadEnvFileIfNeeded(): void {
  if (envLoaded) {
    return;
  }

  const envFile = findEnvFile(process.cwd());
  if (!envFile) {
    envLoaded = true;
    return;
  }

  const content = fs.readFileSync(envFile, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const lineWithoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalIndex = lineWithoutExport.indexOf('=');
    if (equalIndex <= 0) {
      continue;
    }

    const key = lineWithoutExport.slice(0, equalIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const rawValue = lineWithoutExport.slice(equalIndex + 1).trim();
    process.env[key] = stripWrappingQuotes(rawValue);
  }

  envLoaded = true;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function resolveAppEnvironment(): string {
  return (
    process.env.APP_ENV ||
    process.env.LANGFUSE_TRACING_ENVIRONMENT ||
    process.env.NODE_ENV ||
    process.env.DEPLOYMENT_MODE ||
    'development'
  );
}

function isLocalDevelopment(appEnvironment: string): boolean {
  const normalized = appEnvironment.trim().toLowerCase();
  return normalized === 'development' || normalized === 'dev' || normalized === 'local';
}

function normalizeSupabaseHost(identifierOrHost: string): string {
  const value = identifierOrHost.trim();

  // Accept full URLs and strip to hostname.
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      return new URL(value).hostname;
    } catch {
      throw new Error(
        `Invalid connector host/identifier: "${identifierOrHost}". Expected a valid URL or Supabase identifier.`
      );
    }
  }

  // If dots are present, treat as an already-qualified hostname.
  if (value.includes('.')) {
    return value;
  }

  // Otherwise treat as a Supabase project/branch identifier.
  return `db.${value}`;
}

function buildDatabaseUrl(): string {
  // Global explicit override first
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const mode = process.env.DEPLOYMENT_MODE?.toLowerCase();

  if (mode === 'production') {
    if (process.env.DATABASE_PROD_URL) {
      return process.env.DATABASE_PROD_URL;
    }

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
    const host = normalizeSupabaseHost(identifier);
    return `postgresql://postgres:${encodedPassword}@${host}:5432/postgres`;
  }

  if (mode === 'development') {
    if (process.env.DATABASE_DEV_URL) {
      return process.env.DATABASE_DEV_URL;
    }

    if (process.env.DATABASE_LOCAL_URL) {
      return process.env.DATABASE_LOCAL_URL;
    }

    const identifier = process.env.DEV_DB_IDENTIFIER;
    const password = process.env.SUPABASE_DEV_PW;
    if (identifier && password) {
      const encodedPassword = encodeURIComponent(password);
      const host = normalizeSupabaseHost(identifier);
      return `postgresql://postgres:${encodedPassword}@${host}:5432/postgres`;
    }
  }

  // Local fallback
  return 'postgresql://silo:silo_dev@localhost:5432/silo';
}

export class ConfigLoader {
  static load(): Config {
    loadEnvFileIfNeeded();

    const appEnvironment = resolveAppEnvironment();
    const localDevelopment = isLocalDevelopment(appEnvironment);

    const rawConfig = {
      app: {
        name: process.env.APP_NAME || 'silo',
        environment: appEnvironment,
        hostName: process.env.HOST_NAME || process.env.HOSTNAME || os.hostname(),
        promptVersion:
          process.env.PROMPT_VERSION || (localDevelopment ? 'silo-local-dev' : undefined)
      },
      discord: {
        token: process.env.DISCORD_TOKEN,
        clientId: process.env.DISCORD_CLIENT_ID,
        guildId: process.env.DISCORD_GUILD_ID
      },
      providers: {
        openai: process.env.OPENAI_API_KEY
          ? {
              apiKey: process.env.OPENAI_API_KEY,
              model: process.env.OPENAI_MODEL || 'gpt-5.4-nano',
              imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1'
            }
          : undefined,
        anthropic: process.env.ANTHROPIC_API_KEY
          ? {
              apiKey: process.env.ANTHROPIC_API_KEY,
              model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
            }
          : undefined,
        xai: process.env.XAI_API_KEY
          ? {
              apiKey: process.env.XAI_API_KEY,
              model: process.env.XAI_MODEL || 'grok-4.20-non-reasoning',
              imageModel: process.env.XAI_IMAGE_MODEL || 'grok-imagine-image',
              videoModel: process.env.XAI_VIDEO_MODEL || 'grok-imagine-video'
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
              model: process.env.GOOGLE_MODEL || 'gemini-3.1-flash-image-preview'
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
      memory: {
        retrievalLimit: parseOptionalNumber(process.env.MEMORY_RETRIEVAL_LIMIT),
        fallbackLimit: parseOptionalNumber(process.env.MEMORY_FALLBACK_LIMIT),
        triggerThreshold: parseOptionalNumber(process.env.MEMORY_TRIGGER_THRESHOLD),
        semanticMinSimilarity: parseOptionalNumber(process.env.MEMORY_SEMANTIC_MIN_SIMILARITY),
        keywordMentionThreshold: parseOptionalNumber(process.env.MEMORY_KEYWORD_MENTION_THRESHOLD),
        keywordWeight: parseOptionalNumber(process.env.MEMORY_KEYWORD_WEIGHT),
        semanticWeight: parseOptionalNumber(process.env.MEMORY_SEMANTIC_WEIGHT),
        cueWeight: parseOptionalNumber(process.env.MEMORY_CUE_WEIGHT),
        entityWeight: parseOptionalNumber(process.env.MEMORY_ENTITY_WEIGHT)
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
        enableMonitoring: process.env.ENABLE_MONITORING === 'true',
        urlPolicy: {
          denylistDomains: parseCsvList(process.env.URL_DENYLIST_DOMAINS),
          allowlistDomains: parseCsvList(process.env.URL_ALLOWLIST_DOMAINS),
          enforceAllowlist: process.env.URL_ALLOWLIST_ENFORCED === 'true',
          blockKnownShorteners: process.env.URL_BLOCK_KNOWN_SHORTENERS !== 'false',
          safeBrowsingApiKey: process.env.GOOGLE_SAFE_BROWSING_API_KEY
        }
      },
      langfuse: {
        enabled:
          process.env.LANGFUSE_ENABLED === 'true' ||
          Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        userHashSalt: process.env.LANGFUSE_USER_HASH_SALT,
        baseUrl: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_BASEURL,
        sampleRate: parseOptionalNumber(process.env.LANGFUSE_SAMPLE_RATE),
        environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || appEnvironment,
        release: process.env.LANGFUSE_RELEASE,
        timeout: parseOptionalNumber(process.env.LANGFUSE_TIMEOUT),
        flushAt: parseOptionalNumber(process.env.LANGFUSE_FLUSH_AT),
        flushInterval: parseOptionalNumber(process.env.LANGFUSE_FLUSH_INTERVAL),
        exportMode: process.env.LANGFUSE_EXPORT_MODE
      }
    };

    const result = ConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      const formatted = result.error.format();
      logger.error('Configuration validation failed', formatted);
      logger.error('Check your .env file for missing or invalid values.');
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
