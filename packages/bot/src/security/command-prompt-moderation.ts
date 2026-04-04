import { logger } from '@silo/core';
import {
  contentSanitizer,
  detectDeterministicIllicitContent,
  hasPromptInjectionPattern,
  type ContentType
} from './content-sanitizer';

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

const BLOCKED_PROMPT_MESSAGE =
  '⚠️ Prompt blocked by content policy. Please rephrase with safer wording.';

export const moderateCommandPrompt: PromptModerationGuard = async ({
  prompt,
  guildId,
  userId,
  command,
  phase,
  contentType = 'prompt'
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
    const moderationResult = await contentSanitizer.processContent(
      trimmed,
      guildId,
      userId,
      contentType,
      { failClosedOnError: true }
    );

    if (!moderationResult.moderation.allowed || !moderationResult.processedContent.trim()) {
      logger.warn(
        `Blocked ${command} prompt (${phase}) for guild ${guildId}, user ${userId}: ${moderationResult.moderation.flaggedCategories.join(', ') || 'empty_after_sanitize'}`
      );
      return {
        allowed: false,
        processedPrompt: '',
        userMessage: BLOCKED_PROMPT_MESSAGE
      };
    }

    if (moderationResult.moderation.action === 'warned') {
      logger.warn(
        `Warned ${command} prompt (${phase}) for guild ${guildId}, user ${userId}: ${moderationResult.moderation.flaggedCategories.join(', ')}`
      );
    }

    return {
      allowed: true,
      processedPrompt: moderationResult.processedContent
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('ContentSanitizer not initialized')) {
      logger.debug(
        `Prompt moderation unavailable for ${command} (${phase}); using deterministic fallback`,
        {
          guildId,
          userId,
          error
        }
      );
    } else {
      logger.error(
        `Prompt moderation failed for ${command} (${phase}); using deterministic fallback`,
        {
          guildId,
          userId,
          error
        }
      );
    }

    const deterministicCategories = detectDeterministicIllicitContent(trimmed);
    if (deterministicCategories.length > 0 || hasPromptInjectionPattern(trimmed)) {
      return {
        allowed: false,
        processedPrompt: '',
        userMessage: BLOCKED_PROMPT_MESSAGE
      };
    }

    return {
      allowed: true,
      processedPrompt: contentSanitizer.sanitizePrompt(trimmed)
    };
  }
};
