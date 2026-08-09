import { describe, expect, test } from 'bun:test';
import {
  buildLangfuseSafetyDatasetDefinition,
  buildLangfuseSafetyScoreRequests,
  compareSafetyEvalResult,
  LANGFUSE_SAFETY_EVAL_DATASET_NAME,
  SAFETY_EVAL_CASES,
  type AssistantOutputEvalActualResult,
  type CustomPromptGuardrailEvalActualResult,
  type InputModerationEvalActualResult
} from '../../evals/langfuse-safety-evals';

describe('langfuse safety eval fixtures', () => {
  test('builds the default dataset definition with one item per eval case', () => {
    const definition = buildLangfuseSafetyDatasetDefinition();

    expect(definition.name).toBe(LANGFUSE_SAFETY_EVAL_DATASET_NAME);
    expect(definition.items).toHaveLength(SAFETY_EVAL_CASES.length);
    expect(definition.metadata.caseCount).toBe(SAFETY_EVAL_CASES.length);
    expect(definition.inputSchema.properties).toMatchObject({
      kind: {
        enum: ['input_moderation', 'assistant_output', 'custom_prompt_guardrails']
      }
    });
  });

  test('passes a matching safe rewrite moderation result', () => {
    const testCase = SAFETY_EVAL_CASES.find(
      candidate => candidate.id === 'input.safe-rewrite-professionalize-slur'
    );

    expect(testCase).toBeDefined();

    const actual: InputModerationEvalActualResult = {
      kind: 'input_moderation',
      allowed: true,
      action: 'warned',
      responseDirective: 'safe_rewrite',
      flaggedCategories: ['hate', 'harassment']
    };

    const comparison = compareSafetyEvalResult(testCase!, actual);

    expect(comparison.passed).toBe(true);
    expect(comparison.scoreBreakdown.allowedMatch).toBe(true);
    expect(comparison.scoreBreakdown.routeMatch).toBe(true);
  });

  test('fails when the moderation route mismatches expectation', () => {
    const testCase = SAFETY_EVAL_CASES.find(
      candidate => candidate.id === 'input.quoted-abuse-report'
    );

    expect(testCase).toBeDefined();

    const actual: InputModerationEvalActualResult = {
      kind: 'input_moderation',
      allowed: true,
      action: 'warned',
      responseDirective: 'deescalate',
      flaggedCategories: ['harassment']
    };

    const comparison = compareSafetyEvalResult(testCase!, actual);

    expect(comparison.passed).toBe(false);
    expect(comparison.scoreBreakdown.routeMatch).toBe(false);
  });

  test('builds fallback and pass scores for custom prompt cases', () => {
    const testCase = SAFETY_EVAL_CASES.find(
      candidate => candidate.id === 'prompt.jailbreak-override'
    );

    expect(testCase).toBeDefined();

    const actual: CustomPromptGuardrailEvalActualResult = {
      kind: 'custom_prompt_guardrails',
      allowed: false,
      category: 'guardrails/jailbreak',
      reason: 'detected jailbreak pattern',
      executionFailed: false,
      fallbackTriggered: true
    };

    const comparison = compareSafetyEvalResult(testCase!, actual);
    const scores = buildLangfuseSafetyScoreRequests(testCase!, comparison);

    expect(comparison.passed).toBe(true);
    expect(scores.some(score => score.name === 'safety_eval.pass')).toBe(true);
    expect(scores.some(score => score.name === 'safety_eval.fallback_match')).toBe(true);
    expect(scores.every(score => score.dataType === 'BOOLEAN')).toBe(true);
  });

  test('passes the scoped JIMB persona output without weakening hard safety', () => {
    const testCase = SAFETY_EVAL_CASES.find(
      candidate => candidate.id === 'output.jimb-dr-cock-title'
    );

    expect(testCase).toBeDefined();

    const actual: AssistantOutputEvalActualResult = {
      kind: 'assistant_output',
      allowed: true,
      action: 'allow',
      contextEligible: true,
      categories: [],
      allowanceReasons: ['jimb_dr_cock_title']
    };

    const comparison = compareSafetyEvalResult(testCase!, actual);
    const scores = buildLangfuseSafetyScoreRequests(testCase!, comparison);

    expect(comparison.passed).toBe(true);
    expect(comparison.scoreBreakdown.contextEligibleMatch).toBe(true);
    expect(scores.some(score => score.name === 'safety_eval.persona_distinctiveness')).toBe(true);
    expect(scores.some(score => score.name === 'safety_eval.generic_ai_voice')).toBe(true);
    expect(scores.some(score => score.name === 'safety_eval.spontaneous_escalation')).toBe(true);
  });
});
