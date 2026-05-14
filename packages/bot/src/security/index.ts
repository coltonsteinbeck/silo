/**
 * Security Module
 *
 * Exports all security-related functionality for the bot.
 */

export {
  deploymentDetector,
  detectDeploymentMode,
  detectEnvironment,
  isHostedMode,
  isSelfHostedMode,
  getMaxGuilds,
  getDeploymentConfig,
  CONSTANTS as DEPLOYMENT_CONSTANTS
} from './deployment';
export type { DeploymentMode, DeploymentConfig, EnvironmentType } from './deployment';

export { guildManager } from './guild-manager';
export type { GuildInfo, WaitlistEntry, JoinResult } from './guild-manager';

export {
  contentSanitizer,
  buildSafetyResponseInstruction,
  buildUserMessageForBlockedInput
} from './content-sanitizer';
export type {
  ContentType,
  ModerationAction,
  ModerationResponseDirective,
  ModerationResult,
  ModerationLogEntry
} from './content-sanitizer';

export { inactivityScheduler } from './inactivity-scheduler';

export { systemPromptManager, MAX_PROMPT_LENGTH } from './system-prompt';
export type { SystemPromptConfig, SystemPromptValidationResult } from './system-prompt';

export {
  evaluateUserPromptGuardrails,
  evaluateCustomSystemPromptGuardrails,
  evaluateAssistantOutputGuardrails,
  prewarmGuardrailsRuntime,
  isGuardrailsEnabled
} from './openai-guardrails';
export type { GuardrailsPromptDecision } from './openai-guardrails';
export {
  evaluatePromptSafety,
  buildPromptSafetyWarningMessage,
  resetPromptSafetyRuntimeForTests,
  setPromptSafetyRuntimeForTests
} from './prompt-safety';
export type { GuardrailProfile, PromptSafetyResult } from './prompt-safety';

export { composeSystemPromptWithSafety, IMMUTABLE_SAFETY_POLICY } from './safety-policy';
export { resolvePromptPolicy } from './prompt-policy';
export { safetyMonitor, SafetyMonitor, createSafetyMonitorFromEnv } from './safety-monitor';
export {
  sentimentClassifier,
  buildSentimentStyleInstruction,
  shouldApplySentiment,
  isSentimentEnabled,
  classifyPromptDeterministic,
  resetSentimentRuntimeForTests,
  setSentimentRuntimeForTests
} from './sentiment-classifier';
export type { SentimentClassification, SentimentLabel } from './sentiment-classifier';
export {
  profanityPolicy,
  detectMildProfanity,
  sanitizeAssistantProfanity
} from './profanity-policy';
export type {
  SafetyIncidentType,
  SafetyIncidentRecord,
  SafetyMonitorConfig,
  SafetyMonitorDecision
} from './safety-monitor';
