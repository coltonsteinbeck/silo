import { describe, expect, test } from 'bun:test';
import type { AgentGraphResult } from '../../agent/types';
import {
  type DirectCandidateAssessment,
  recoverUnsafeAgentResponse,
  recoverUnsafeDirectResponse
} from '../../services/assistant-response-recovery';

function graphResult(blocked: boolean, content: string): AgentGraphResult {
  return {
    response: { content, model: 'mock-model' },
    safetyState: blocked ? 'output_blocked' : 'allowed',
    outcome: blocked ? 'blocked' : 'success',
    toolsAllowed: [],
    toolsCalled: [],
    toolResults: [],
    citations: [],
    stepCount: 7,
    outputSafety: {
      decision: {
        action: blocked ? 'block' : 'allow',
        stage: 'assistant_output',
        categories: blocked ? ['sexual/explicit_generation'] : [],
        scores: {},
        reasons: blocked ? ['sexual/explicit_generation'] : [],
        detectorSources: ['deterministic'],
        contextEligible: !blocked,
        failed: false,
        semanticRisk: blocked
      },
      quality: {
        repetitive: false,
        reason: null,
        maxSimilarity: 0,
        recurringPhraseCount: 0
      },
      blocked,
      normalized: false,
      repaired: false,
      categories: blocked ? ['sexual/explicit_generation'] : [],
      reasons: blocked ? ['sexual/explicit_generation'] : [],
      outputWasReplaced: blocked,
      candidateHash: blocked ? 'blocked-candidate-hash' : 'safe-candidate-hash',
      candidatePreview: content
    }
  };
}

function directAssessment(
  action: 'allow' | 'block',
  options: { repetitive?: boolean } = {}
): DirectCandidateAssessment {
  const repetitive = options.repetitive ?? false;
  return {
    decision: {
      action,
      stage: 'assistant_output',
      categories: action === 'block' ? ['sexual/explicit_generation'] : [],
      scores: {},
      reasons: action === 'block' ? ['sexual/explicit_generation'] : [],
      detectorSources: ['deterministic'],
      contextEligible: action === 'allow' && !repetitive,
      failed: false,
      semanticRisk: action === 'block'
    },
    quality: {
      repetitive,
      reason: repetitive ? 'high_similarity' : null,
      maxSimilarity: repetitive ? 0.92 : 0,
      recurringPhraseCount: repetitive ? 2 : 0
    }
  };
}

describe('assistant response recovery', () => {
  test('does not retry a safe primary response', async () => {
    let calls = 0;
    const primary = graphResult(false, 'Fresh safe answer.');
    const result = await recoverUnsafeAgentResponse({
      primaryResult: primary,
      inputSafetyAction: 'allow',
      runContextFreeRetry: async () => {
        calls += 1;
        return graphResult(false, 'unused');
      }
    });

    expect(calls).toBe(0);
    expect(result.result).toBe(primary);
    expect(result.retryCount).toBe(0);
  });

  test('performs exactly one context-free retry for safe input and unsafe output', async () => {
    let calls = 0;
    const primary = graphResult(true, 'unsafe candidate');
    primary.response.usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const recovered = graphResult(false, 'A clean answer to the latest prompt.');
    recovered.response.usage = { promptTokens: 7, completionTokens: 4, totalTokens: 11 };
    const result = await recoverUnsafeAgentResponse({
      primaryResult: primary,
      inputSafetyAction: 'allow',
      runContextFreeRetry: async () => {
        calls += 1;
        return recovered;
      }
    });

    expect(calls).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.retrySucceeded).toBe(true);
    expect(result.result.response.content).toBe(recovered.response.content);
    expect(result.result.response.usage).toMatchObject({
      promptTokens: 17,
      completionTokens: 9,
      totalTokens: 26
    });
    expect(result.originalCandidateHash).toBe('blocked-candidate-hash');
  });

  test('never loops when the single retry is also unsafe', async () => {
    let calls = 0;
    const failedRetry = graphResult(true, 'second unsafe candidate');
    const result = await recoverUnsafeAgentResponse({
      primaryResult: graphResult(true, 'first unsafe candidate'),
      inputSafetyAction: 'allow',
      runContextFreeRetry: async () => {
        calls += 1;
        return failedRetry;
      }
    });

    expect(calls).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.retrySucceeded).toBe(false);
    expect(result.result.response.content).toBe(failedRetry.response.content);
  });

  test('does not retry an unsafe candidate derived from redirected input', async () => {
    let calls = 0;
    const primary = graphResult(true, 'unsafe candidate');
    const result = await recoverUnsafeAgentResponse({
      primaryResult: primary,
      inputSafetyAction: 'redirect',
      runContextFreeRetry: async () => {
        calls += 1;
        return graphResult(false, 'unused');
      }
    });

    expect(calls).toBe(0);
    expect(result.result).toBe(primary);
    expect(result.retryCount).toBe(0);
  });
});

describe('direct assistant response recovery', () => {
  test('does not retry a safe direct response', async () => {
    let retryCalls = 0;
    let assessmentCalls = 0;
    const primaryResponse = { content: 'Fresh safe answer.', model: 'mock-model' };
    const result = await recoverUnsafeDirectResponse({
      primaryResponse,
      inputSafetyAction: 'allow',
      assess: async () => {
        assessmentCalls += 1;
        return directAssessment('allow');
      },
      runContextFreeRetry: async () => {
        retryCalls += 1;
        return { content: 'unused', model: 'mock-model' };
      },
      buildFallback: () => 'unused fallback'
    });

    expect(assessmentCalls).toBe(1);
    expect(retryCalls).toBe(0);
    expect(result.response).toBe(primaryResponse);
    expect(result.retryCount).toBe(0);
    expect(result.retrySucceeded).toBe(false);
    expect(result.originalAssessment).toBeNull();
    expect(result.originalContent).toBeNull();
  });

  test('performs exactly one retry for an unsafe primary and merges retry-safe usage', async () => {
    let retryCalls = 0;
    const assessments = new Map([
      ['unsafe primary', directAssessment('block')],
      ['safe retry', directAssessment('allow')]
    ]);
    const result = await recoverUnsafeDirectResponse({
      primaryResponse: {
        content: 'unsafe primary',
        model: 'mock-model',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      },
      inputSafetyAction: 'allow',
      assess: async content => assessments.get(content)!,
      runContextFreeRetry: async () => {
        retryCalls += 1;
        return {
          content: 'safe retry',
          model: 'mock-model',
          usage: { promptTokens: 7, completionTokens: 4, totalTokens: 11 }
        };
      },
      buildFallback: () => 'unused fallback'
    });

    expect(retryCalls).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.retrySucceeded).toBe(true);
    expect(result.response.content).toBe('safe retry');
    expect(result.response.usage).toMatchObject({
      promptTokens: 17,
      completionTokens: 9,
      totalTokens: 26
    });
    expect(result.originalAssessment).toBe(assessments.get('unsafe primary')!);
    expect(result.originalContent).toBe('unsafe primary');
  });

  test('performs exactly one retry for a quality-repetitive primary', async () => {
    let retryCalls = 0;
    const result = await recoverUnsafeDirectResponse({
      primaryResponse: { content: 'repetitive primary', model: 'mock-model' },
      inputSafetyAction: 'allow',
      assess: async content =>
        content === 'repetitive primary'
          ? directAssessment('allow', { repetitive: true })
          : directAssessment('allow'),
      runContextFreeRetry: async () => {
        retryCalls += 1;
        return { content: 'fresh retry', model: 'mock-model' };
      },
      buildFallback: () => 'unused fallback'
    });

    expect(retryCalls).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.retrySucceeded).toBe(true);
    expect(result.response.content).toBe('fresh retry');
    expect(result.originalAssessment?.quality.repetitive).toBe(true);
  });

  test('uses one stable fallback when the single retry is also unsafe', async () => {
    let retryCalls = 0;
    let assessmentCalls = 0;
    let fallbackCalls = 0;
    const fallback = 'Stable category fallback.';
    const result = await recoverUnsafeDirectResponse({
      primaryResponse: { content: 'unsafe primary', model: 'mock-model' },
      inputSafetyAction: 'allow',
      assess: async () => {
        assessmentCalls += 1;
        return directAssessment('block');
      },
      runContextFreeRetry: async () => {
        retryCalls += 1;
        return { content: 'unsafe retry', model: 'mock-model' };
      },
      buildFallback: assessment => {
        fallbackCalls += 1;
        expect(assessment.decision.action).toBe('block');
        return fallback;
      }
    });

    expect(retryCalls).toBe(1);
    expect(assessmentCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
    expect(result.retryCount).toBe(1);
    expect(result.retrySucceeded).toBe(false);
    expect(result.response.content).toBe(fallback);
  });

  test('does not retry a rejected candidate derived from redirected input', async () => {
    let retryCalls = 0;
    const primaryResponse = { content: 'rejected primary', model: 'mock-model' };
    const assessment = directAssessment('block');
    const result = await recoverUnsafeDirectResponse({
      primaryResponse,
      inputSafetyAction: 'redirect',
      assess: async () => assessment,
      runContextFreeRetry: async () => {
        retryCalls += 1;
        return { content: 'unused', model: 'mock-model' };
      },
      buildFallback: () => 'unused fallback'
    });

    expect(retryCalls).toBe(0);
    expect(result.response).toBe(primaryResponse);
    expect(result.assessment).toBe(assessment);
    expect(result.retryCount).toBe(0);
    expect(result.originalAssessment).toBeNull();
  });
});
