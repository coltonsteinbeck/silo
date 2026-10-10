import { buildContextReuseSafetyDecision } from '../../security/safety-decision';
import { describe, expect, test } from 'bun:test';
import {
  resolveConversationTurnDisposition,
  type ConversationTurnDispositionInput
} from '../../services/conversation-turn-disposition';

function allowedInput(
  overrides: Partial<ConversationTurnDispositionInput> = {}
): ConversationTurnDispositionInput {
  return {
    responseContent: 'Useful answer with a mildly cursed aside.',
    inputSafetyAction: 'allow',
    inputContextEligible: true,
    assistantModerationAllowed: true,
    outputContextEligible: true,
    outputQualityRepetitive: false,
    fallbackOnly: false,
    outputBlockedBySafety: false,
    outputRejectedForQuality: false,
    responseIntent: 'ordinary',
    replyFileCount: 0,
    graphOutcome: 'success',
    outputRetryCount: 0,
    outputRetrySucceeded: false,
    recoveryStrategy: null,
    assistantIncidentWasQualityOnly: false,
    ...overrides
  };
}

describe('conversation turn disposition', () => {
  test('marks a clean text turn eligible for future prompt context', () => {
    expect(resolveConversationTurnDisposition(allowedInput())).toEqual({
      promptEligible: true,
      safetyState: 'allowed',
      genericSafetyFallback: false
    });
  });

  test('never makes a generic safety fallback prompt-eligible', () => {
    const result = resolveConversationTurnDisposition(
      allowedInput({
        responseContent:
          'I can’t help with that request. Please rephrase and I can provide a safer alternative.'
      })
    );

    expect(result.promptEligible).toBe(false);
    expect(result.genericSafetyFallback).toBe(true);
  });

  test('records blocked and repaired output states without weakening eligibility gates', () => {
    expect(
      resolveConversationTurnDisposition(
        allowedInput({ assistantModerationAllowed: false, outputBlockedBySafety: true })
      )
    ).toMatchObject({ promptEligible: false, safetyState: 'output_blocked' });

    expect(
      resolveConversationTurnDisposition(
        allowedInput({
          outputRetryCount: 1,
          outputRetrySucceeded: true,
          recoveryStrategy: 'latest_turn_safety_retry'
        })
      )
    ).toMatchObject({ promptEligible: true, safetyState: 'output_repaired' });
  });
});

test.each([
  ['inactive_persona_residue', true],
  ['assistant_output_guardrail', false]
] as const)('uses the actual history decision for %s', (reason, eligible) => {
  const history = buildContextReuseSafetyDecision({
    selectedMessageCount: 3,
    removedReasons: [reason]
  });
  const disposition = resolveConversationTurnDisposition(
    allowedInput({ contextReuseAction: history.action })
  );
  expect(disposition.promptEligible).toBe(eligible);
  expect(disposition.safetyState).toBe('allowed');
});
