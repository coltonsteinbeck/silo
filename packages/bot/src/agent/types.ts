import type {
  Message,
  ProviderCapabilities,
  TextGenerationResponse,
  TextProvider
} from '@silo/core';
import type { AgentGraphLimits } from './config';
import type { AgentIntent } from './intent-router';
import type { AgentMediaResult, AgentToolExecutor } from './tool-executor';
import type { LangfuseMetadataInput } from '../telemetry/langfuse-metadata';
import type { SafetyDecision } from '../security/safety-decision';
import type { ResponseQualityResult } from '../services/response-quality';

export type AgentToolName =
  | 'web_search'
  | 'image_generation'
  | 'video_generation'
  | 'vision_analysis';

export type AgentSafetyState =
  | 'allowed'
  | 'input_blocked'
  | 'output_blocked'
  | 'quality_blocked'
  | 'output_repaired'
  | 'bounded_failure';
export type AgentGraphOutcome = 'success' | 'blocked' | 'repaired' | 'bounded_failure' | 'error';
export interface AgentOutputSafetyResult {
  decision: SafetyDecision;
  quality: ResponseQualityResult;
  blocked: boolean;
  normalized: boolean;
  repaired: boolean;
  categories: string[];
  reasons: string[];
  outputWasReplaced: boolean;
  candidateHash: string;
  candidatePreview: string;
}

export interface AgentToolRequest {
  name: AgentToolName;
  input?: Record<string, unknown>;
}

export interface AgentToolResult {
  name: AgentToolName;
  status: 'success' | 'skipped' | 'unsupported' | 'budget_exceeded' | 'error';
  message: string;
  content?: string;
  citations?: Array<{ url: string; title?: string }>;
  query?: string;
  provider?: string;
  model?: string;
  media?: AgentMediaResult;
}

export interface AgentProviderCapabilities {
  providerName: string;
  model?: string;
  capabilities?: ProviderCapabilities;
  hasImageProvider?: boolean;
  hasVideoProvider?: boolean;
  hasWebSearch?: boolean;
}

export interface AgentGraphInput {
  messages: Message[];
  textProvider: TextProvider;
  generationOptions?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
  };
  provider: AgentProviderCapabilities;
  limits: AgentGraphLimits;
  intent?: AgentIntent;
  intentConfidence?: number;
  intentReason?: string;
  clarificationReason?: string;
  falsePositiveGuard?: string;
  outputBlockedMessage?: string;
  allowMildAssistantProfanity?: boolean;
  inheritedSafetyRisk?: boolean;
  recentAssistantMessages?: string[];
  latestUserText?: string;
  requestedTools?: AgentToolRequest[];
  toolExecutor?: AgentToolExecutor;
  metadata: LangfuseMetadataInput;
}

export interface AgentGraphResult {
  response: TextGenerationResponse;
  safetyState: AgentSafetyState;
  outcome: AgentGraphOutcome;
  toolsAllowed: AgentToolName[];
  toolsCalled: AgentToolName[];
  toolResults: AgentToolResult[];
  citations: Array<{ url: string; title?: string }>;
  mediaResult?: AgentMediaResult;
  outputSafety?: AgentOutputSafetyResult;
  stepCount: number;
}

export interface AgentGraphState extends AgentGraphInput {
  graphStep: number;
  safetyState: AgentSafetyState;
  toolsAllowed: AgentToolName[];
  toolsCalled: AgentToolName[];
  toolResults: AgentToolResult[];
  citations: Array<{ url: string; title?: string }>;
  mediaResult?: AgentMediaResult;
  outputSafety?: AgentOutputSafetyResult;
  modelResponse?: TextGenerationResponse;
  outcome?: AgentGraphOutcome;
}
