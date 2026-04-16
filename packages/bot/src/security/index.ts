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

export { contentSanitizer, buildUserMessageForBlockedInput } from './content-sanitizer';
export type {
  ContentType,
  ModerationAction,
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
  isGuardrailsEnabled
} from './openai-guardrails';
export type { GuardrailsPromptDecision } from './openai-guardrails';

export { composeSystemPromptWithSafety, IMMUTABLE_SAFETY_POLICY } from './safety-policy';
export { resolvePromptPolicy } from './prompt-policy';
export { safetyMonitor, SafetyMonitor, createSafetyMonitorFromEnv } from './safety-monitor';
export type {
  SafetyIncidentType,
  SafetyIncidentRecord,
  SafetyMonitorConfig,
  SafetyMonitorDecision
} from './safety-monitor';
