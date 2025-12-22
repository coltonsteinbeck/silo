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

export { contentSanitizer } from './content-sanitizer';
export type {
  ContentType,
  ModerationAction,
  ModerationResult,
  ModerationLogEntry
} from './content-sanitizer';

export { inactivityScheduler } from './inactivity-scheduler';

export { systemPromptManager, MAX_PROMPT_LENGTH } from './system-prompt';
export type { SystemPromptConfig, SystemPromptValidationResult } from './system-prompt';
