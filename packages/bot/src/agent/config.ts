export const AGENT_GRAPH_NAME = 'discord-message-agent';
export const AGENT_GRAPH_VERSION = 'v2';

export interface AgentGraphLimits {
  recursionLimit: number;
  maxToolRounds: number;
  maxToolCalls: number;
  maxWebSearches: number;
  maxPagesFetched: number;
  maxImageGenerations: number;
  maxVideoGenerations: number;
}

export interface AgentGraphRuntimeConfig {
  enabled: boolean;
  mode: 'off' | 'shadow' | 'staging' | 'on' | 'active';
  searchEnabled: boolean;
  mediaNaturalLanguageEnabled: boolean;
  searchFallbackProvider: 'disabled' | 'openai' | 'xai';
  limits: AgentGraphLimits;
}

const DEFAULT_LIMITS: AgentGraphLimits = {
  recursionLimit: 16,
  maxToolRounds: 1,
  maxToolCalls: 3,
  maxWebSearches: 2,
  maxPagesFetched: 3,
  maxImageGenerations: 1,
  maxVideoGenerations: 1
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

function parseMode(value: string | undefined, enabled: boolean): AgentGraphRuntimeConfig['mode'] {
  const normalized = (value || '').trim().toLowerCase();
  if (
    normalized === 'active' ||
    normalized === 'on' ||
    normalized === 'staging' ||
    normalized === 'shadow' ||
    normalized === 'off'
  ) {
    return normalized;
  }

  return enabled ? 'on' : 'off';
}

function parseSearchFallbackProvider(
  value: string | undefined
): AgentGraphRuntimeConfig['searchFallbackProvider'] {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'xai') {
    return normalized;
  }
  return 'disabled';
}

export function createAgentGraphRuntimeConfig(
  env: Record<string, string | undefined> = process.env
): AgentGraphRuntimeConfig {
  const enabled = parseBoolean(env.AGENT_GRAPH_ENABLED);

  return {
    enabled,
    mode: parseMode(env.AGENT_GRAPH_MODE, enabled),
    searchEnabled: parseBoolean(env.AGENT_SEARCH_ENABLED),
    mediaNaturalLanguageEnabled: parseBoolean(env.AGENT_MEDIA_NL_ENABLED),
    searchFallbackProvider: parseSearchFallbackProvider(env.AGENT_SEARCH_FALLBACK_PROVIDER),
    limits: {
      recursionLimit: parsePositiveInt(
        env.AGENT_GRAPH_RECURSION_LIMIT,
        DEFAULT_LIMITS.recursionLimit
      ),
      maxToolRounds: parsePositiveInt(
        env.AGENT_GRAPH_MAX_TOOL_ROUNDS,
        DEFAULT_LIMITS.maxToolRounds
      ),
      maxToolCalls: parsePositiveInt(env.AGENT_GRAPH_MAX_TOOL_CALLS, DEFAULT_LIMITS.maxToolCalls),
      maxWebSearches: parsePositiveInt(
        env.AGENT_GRAPH_MAX_WEB_SEARCHES,
        DEFAULT_LIMITS.maxWebSearches
      ),
      maxPagesFetched: parsePositiveInt(
        env.AGENT_GRAPH_MAX_PAGES_FETCHED,
        DEFAULT_LIMITS.maxPagesFetched
      ),
      maxImageGenerations: parsePositiveInt(
        env.AGENT_GRAPH_MAX_IMAGE_GENERATIONS,
        DEFAULT_LIMITS.maxImageGenerations
      ),
      maxVideoGenerations: parsePositiveInt(
        env.AGENT_GRAPH_MAX_VIDEO_GENERATIONS,
        DEFAULT_LIMITS.maxVideoGenerations
      )
    }
  };
}

export function getDefaultAgentGraphLimits(): AgentGraphLimits {
  return { ...DEFAULT_LIMITS };
}
