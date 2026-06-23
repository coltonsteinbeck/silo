import { logger } from '@silo/core';
import { contentSanitizer, type ContentType } from './content-sanitizer';
import { buildPromptSafetyWarningMessage, evaluatePromptSafety } from './prompt-safety';

export interface CommandPromptModerationDecision {
  allowed: boolean;
  processedPrompt: string;
  userMessage?: string;
}

export type PromptModerationGuard = (params: {
  prompt: string;
  guildId: string | null;
  userId: string;
  command: string;
  phase: string;
  contentType?: ContentType;
}) => Promise<CommandPromptModerationDecision>;

export const moderateCommandPrompt: PromptModerationGuard = async ({
  prompt,
  guildId,
  userId,
  command,
  phase,
  contentType: _contentType = 'prompt'
}) => {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return {
      allowed: false,
      processedPrompt: '',
      userMessage: '⚠️ Prompt cannot be empty.'
    };
  }

  if (!guildId) {
    return {
      allowed: true,
      processedPrompt: trimmed
    };
  }

  try {
    const safetyResult = await evaluatePromptSafety(trimmed, {
      profile: 'strict_tool_input',
      source: `${command}:${phase}`,
      userId
    });

    if (safetyResult.moderationError) {
      logger.error(`Prompt moderation failed closed for ${command} (${phase})`, {
        guildId,
        userId,
        moderationError: safetyResult.moderationError
      });
      return {
        allowed: false,
        processedPrompt: '',
        userMessage:
          '⚠️ Prompt moderation is temporarily unavailable. Please try again in a moment.'
      };
    }

    if (!safetyResult.allowed) {
      logger.warn(
        `Blocked ${command} prompt (${phase}) for guild ${guildId}, user ${userId}: ${[...safetyResult.reasons, ...safetyResult.moderationCategories].join(', ') || 'empty_after_sanitize'}`
      );
      return {
        allowed: false,
        processedPrompt: '',
        userMessage: buildPromptSafetyWarningMessage({
          profile: 'strict_tool_input',
          reasons: safetyResult.reasons,
          moderationCategories: safetyResult.moderationCategories
        })
      };
    }

    return {
      allowed: true,
      processedPrompt: contentSanitizer.sanitizePrompt(trimmed)
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('ContentSanitizer not initialized')) {
      logger.debug(`Prompt moderation unavailable for ${command} (${phase}); blocking prompt`, {
        guildId,
        userId,
        error
      });
    } else {
      logger.error(`Prompt moderation failed for ${command} (${phase}); blocking prompt`, {
        guildId,
        userId,
        error
      });
    }

    return {
      allowed: false,
      processedPrompt: '',
      userMessage: '⚠️ Prompt moderation is temporarily unavailable. Please try again in a moment.'
    };
  }
};
