import { z } from 'zod';

export const ProviderConfigSchema = z.object({
  openai: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('gpt-4o-mini'),
      baseURL: z.string().url().optional()
    })
    .optional(),
  anthropic: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('claude-3-5-sonnet-20241022')
    })
    .optional(),
  xai: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('grok-beta'),
      baseURL: z.string().url().default('https://api.x.ai/v1')
    })
    .optional(),
  google: z
    .object({
      apiKey: z.string().optional(),
      model: z.string().default('gemini-2.0-flash-exp')
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

export const MLServiceConfigSchema = z.object({
  url: z.string().url(),
  timeout: z.number().int().positive().default(30000),
  enabled: z.boolean().default(false)
});

export const SecurityConfigSchema = z.object({
  healthCheckSecret: z.string().min(32).optional(),
  alertWebhookUrl: z.string().url().optional(),
  enableMonitoring: z.boolean().default(false)
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
  mlService: MLServiceConfigSchema.optional(),
  security: SecurityConfigSchema
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
