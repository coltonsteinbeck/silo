import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  openai: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('gpt-5.4-nano'),
      imageModel: z.string().default('gpt-image-1'),
      baseURL: z.string().url().optional()
    })
    .optional(),
  anthropic: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('claude-sonnet-4-6')
    })
    .optional(),
  xai: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('grok-4.20-non-reasoning'),
      imageModel: z.string().default('grok-imagine-image'),
      videoModel: z.string().default('grok-imagine-video'),
      baseURL: z.string().url().default('https://api.x.ai/v1')
    })
    .optional(),
  local: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('llama3.1'),
      baseURL: z.string().url().default('http://localhost:11434/v1')
    })
    .optional(),
  google: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().optional(), // Deprecated: use textModel/imageModel
      textModel: z.string().optional(),
      imageModel: z.string().optional()
    })
    .optional()
});

export const DatabaseConfigSchema = z.object({
  url: z.string().min(1),
  maxConnections: z.number().int().positive().default(10),
  ssl: z.boolean().default(false)
});

export const RedisConfigSchema = z.object({
  url: z.string().min(1),
  maxRetries: z.number().int().default(3)
});

export const RateLimitConfigSchema = z.object({
  commandsPerUser: z.number().int().positive().default(10),
  aiRequestsPerGuild: z.number().int().positive().default(50),
  voiceSessionsPerGuild: z.number().int().positive().default(3)
});

export const FeaturesConfigSchema = z.object({
  enableRAG: z.boolean().default(false),
  enableLocalModels: z.boolean().default(false),
  enableVoice: z.boolean().default(true),
  enableImages: z.boolean().default(true)
});

export const MemoryConfigSchema = z.object({
  retrievalLimit: z.number().int().min(1).max(12).default(4),
  fallbackLimit: z.number().int().min(1).max(3).default(1),
  triggerThreshold: z.number().min(0).max(1).default(0.45),
  semanticMinSimilarity: z.number().min(0).max(1).default(0.62),
  keywordMentionThreshold: z.number().min(0).max(1).default(0.55),
  keywordWeight: z.number().min(0).max(1).default(0.15),
  semanticWeight: z.number().min(0).max(1).default(0.75),
  cueWeight: z.number().min(0).max(1).default(0.07),
  entityWeight: z.number().min(0).max(1).default(0.03)
});

export const MLServiceConfigSchema = z.object({
  url: z.string().url(),
  timeout: z.number().int().positive().default(30000),
  enabled: z.boolean().default(false)
});

export const SecurityConfigSchema = z.object({
  healthCheckSecret: z.string().min(32).optional().or(z.literal('')),
  alertWebhookUrl: z.string().url().optional().or(z.literal('')),
  enableMonitoring: z.boolean().default(false),
  urlPolicy: z
    .object({
      denylistDomains: z.array(z.string().min(1)).default([]),
      allowlistDomains: z.array(z.string().min(1)).default([]),
      enforceAllowlist: z.boolean().default(false),
      blockKnownShorteners: z.boolean().default(true),
      safeBrowsingApiKey: z.string().optional().or(z.literal(''))
    })
    .default({
      denylistDomains: [],
      allowlistDomains: [],
      enforceAllowlist: false,
      blockKnownShorteners: true,
      safeBrowsingApiKey: ''
    })
});

export const ConfigSchema = z.object({
  discord: z.object({
    token: z.string().min(50),
    clientId: z.string().min(1),
    guildId: z.string().optional()
  }),
  providers: ProviderConfigSchema,
  database: DatabaseConfigSchema,
  redis: RedisConfigSchema,
  rateLimits: RateLimitConfigSchema,
  features: FeaturesConfigSchema,
  memory: MemoryConfigSchema.default({
    retrievalLimit: 4,
    fallbackLimit: 1,
    triggerThreshold: 0.45,
    semanticMinSimilarity: 0.62,
    keywordMentionThreshold: 0.55,
    keywordWeight: 0.15,
    semanticWeight: 0.75,
    cueWeight: 0.07,
    entityWeight: 0.03
  }),
  mlService: MLServiceConfigSchema.optional(),
  security: SecurityConfigSchema
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
