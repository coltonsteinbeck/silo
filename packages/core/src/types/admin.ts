export interface ServerConfig {
  guildId: string;
  defaultProvider?: string;
  autoThread: boolean;
  memoryRetentionDays: number;
  rateLimitMultiplier: number;
  featuresEnabled: Record<string, boolean>;
  channelConfigs: Record<string, ChannelConfig>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChannelConfig {
  mode?: 'chat' | 'support' | 'creative' | 'silent';
  aiProvider?: string;
  autoThread?: boolean;
  autoRespond?: boolean;
}

export interface AuditLog {
  id: string;
  guildId: string;
  userId: string;
  action: string;
  targetId?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

export interface ModAction {
  id: string;
  guildId: string;
  moderatorId: string;
  targetUserId?: string;
  actionType: 'warn' | 'timeout' | 'kick' | 'ban' | 'purge';
  reason: string;
  duration?: number;
  messageCount?: number;
  createdAt: Date;
}

export interface AnalyticsEvent {
  id: string;
  guildId: string;
  userId: string;
  eventType: string;
  command?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  tokensUsed?: number;
  durationMs?: number;
  estimatedCostUsd?: number;
  responseTimeMs?: number;
  success: boolean;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface UserRole {
  guildId: string;
  userId: string;
  roleTier: 'admin' | 'moderator' | 'trusted' | 'member' | 'restricted';
  grantedBy?: string;
  grantedAt: Date;
}

export interface ResponseFeedback {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  feedbackType: 'positive' | 'negative' | 'regenerate' | 'save' | 'delete';
  originalProvider?: string;
  createdAt: Date;
}

export interface RateLimits {
  commands: number;
  ai: number;
  video: number;
  search: number;
}

export const ROLE_RATE_LIMITS: Record<UserRole['roleTier'], RateLimits> = {
  admin: { commands: 1000, ai: 1000, video: 50, search: 100 },
  moderator: { commands: 500, ai: 500, video: 25, search: 50 },
  trusted: { commands: 100, ai: 100, video: 10, search: 20 },
  member: { commands: 50, ai: 50, video: 5, search: 10 },
  restricted: { commands: 10, ai: 10, video: 1, search: 2 }
};
