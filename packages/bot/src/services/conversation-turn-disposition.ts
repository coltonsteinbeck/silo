import type { AgentGraphOutcome } from '../agent/types';
import type { ResponseIntent } from '../security/persona-state';
import type { SafetyAction } from '../security/safety-decision';
import type { AssistantRecoveryStrategy } from './assistant-response-recovery';
import { isGenericSafetyFallbackContent } from './conversation-history-sanitizer';

export type ConversationTurnSafetyState =
  | 'allowed'
  | 'fallback_only'
  | 'output_blocked'
  | 'output_repaired'
  | 'quality_failed'
  | 'quality_repaired'
  | 'redirected_explicit';

export interface ConversationTurnDispositionInput {
  responseContent: string;
  inputSafetyAction?: SafetyAction;
  inputContextEligible?: boolean;
  contextReuseAction?: SafetyAction;
  assistantModerationAllowed: boolean;
  outputContextEligible?: boolean;
  outputQualityRepetitive?: boolean;
  fallbackOnly: boolean;
  outputBlockedBySafety: boolean;
  outputRejectedForQuality: boolean;
  responseIntent: ResponseIntent;
  replyFileCount: number;
  graphOutcome?: AgentGraphOutcome | null;
  outputRetryCount: number;
  outputRetrySucceeded: boolean;
  recoveryStrategy: AssistantRecoveryStrategy | null;
  assistantIncidentWasQualityOnly: boolean;
}

export interface ConversationTurnDisposition {
  promptEligible: boolean;
  safetyState: ConversationTurnSafetyState;
  genericSafetyFallback: boolean;
}

/**
 * Resolves the post-generation state shared by Discord delivery telemetry and
 * conversation persistence. Keep this pure so every caller applies one
 * prompt-history eligibility policy to the exact content being delivered.
 */
export function resolveConversationTurnDisposition(
  input: ConversationTurnDispositionInput
): ConversationTurnDisposition {
  const genericSafetyFallback = isGenericSafetyFallbackContent(input.responseContent);
  const promptEligible = Boolean(
    input.inputSafetyAction === 'allow' &&
    input.inputContextEligible &&
    input.contextReuseAction !== 'block' &&
    input.assistantModerationAllowed &&
    (input.outputContextEligible ?? true) &&
    !input.outputQualityRepetitive &&
    !input.fallbackOnly &&
    !genericSafetyFallback &&
    !input.outputBlockedBySafety &&
    input.responseIntent !== 'boundary_redirect' &&
    input.replyFileCount === 0 &&
    input.graphOutcome !== 'bounded_failure' &&
    (input.outputRetryCount === 0 || input.outputRetrySucceeded)
  );
  const safetyState: ConversationTurnSafetyState = input.outputRejectedForQuality
    ? 'quality_failed'
    : !input.assistantModerationAllowed || input.outputBlockedBySafety
      ? 'output_blocked'
      : input.outputRetrySucceeded &&
          (input.outputRetryCount > 0 || input.recoveryStrategy === 'deterministic_slur_mask')
        ? input.assistantIncidentWasQualityOnly
          ? 'quality_repaired'
          : 'output_repaired'
        : input.inputSafetyAction === 'redirect'
          ? 'redirected_explicit'
          : input.fallbackOnly || input.graphOutcome === 'bounded_failure'
            ? 'fallback_only'
            : 'allowed';

  return { promptEligible, safetyState, genericSafetyFallback };
}
