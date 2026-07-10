import type { TextGenerationResponse } from '@silo/core';
import type { AgentGraphResult } from '../agent/types';
import type { SafetyAction, SafetyDecision } from '../security/safety-decision';
import type { ResponseQualityResult } from './response-quality';

type Usage = NonNullable<AgentGraphResult['response']['usage']>;

export function mergeTextGenerationUsage(
  primary: Usage | undefined,
  retry: Usage | undefined
): Usage | undefined {
  if (!primary) return retry;
  if (!retry) return primary;

  return {
    promptTokens: primary.promptTokens + retry.promptTokens,
    completionTokens: primary.completionTokens + retry.completionTokens,
    totalTokens: primary.totalTokens + retry.totalTokens,
    reasoningTokens: (primary.reasoningTokens || 0) + (retry.reasoningTokens || 0),
    cacheCreationTokens: (primary.cacheCreationTokens || 0) + (retry.cacheCreationTokens || 0),
    cacheReadTokens: (primary.cacheReadTokens || 0) + (retry.cacheReadTokens || 0)
  };
}

export interface AssistantResponseRecoveryResult {
  result: AgentGraphResult;
  retryCount: 0 | 1;
  retrySucceeded: boolean;
  originalCandidateHash: string | null;
  originalCandidatePreview: string | null;
  originalCandidateCategories: string[];
}

export async function recoverUnsafeAgentResponse(params: {
  primaryResult: AgentGraphResult;
  inputSafetyAction: SafetyAction;
  runContextFreeRetry: () => Promise<AgentGraphResult>;
}): Promise<AssistantResponseRecoveryResult> {
  const originalSafety = params.primaryResult.outputSafety;
  if (!originalSafety?.blocked || params.inputSafetyAction !== 'allow') {
    return {
      result: params.primaryResult,
      retryCount: 0,
      retrySucceeded: false,
      originalCandidateHash: null,
      originalCandidatePreview: null,
      originalCandidateCategories: []
    };
  }

  const recovered = await params.runContextFreeRetry();
  const result = {
    ...recovered,
    response: {
      ...recovered.response,
      usage: mergeTextGenerationUsage(params.primaryResult.response.usage, recovered.response.usage)
    }
  };
  const retrySucceeded =
    (recovered.outcome === 'success' || recovered.outcome === 'repaired') &&
    !recovered.outputSafety?.blocked;
  return {
    result,
    retryCount: 1,
    retrySucceeded,
    originalCandidateHash: originalSafety.candidateHash,
    originalCandidatePreview: originalSafety.candidatePreview,
    originalCandidateCategories: [...originalSafety.categories]
  };
}

export interface DirectCandidateAssessment {
  decision: SafetyDecision;
  quality: ResponseQualityResult;
}

export interface DirectResponseRecoveryResult {
  response: TextGenerationResponse;
  assessment: DirectCandidateAssessment;
  originalAssessment: DirectCandidateAssessment | null;
  originalContent: string | null;
  retryCount: 0 | 1;
  retrySucceeded: boolean;
}

function isDirectCandidateRejected(assessment: DirectCandidateAssessment): boolean {
  return assessment.decision.action === 'block' || assessment.quality.repetitive;
}

export async function recoverUnsafeDirectResponse(params: {
  primaryResponse: TextGenerationResponse;
  inputSafetyAction: SafetyAction;
  assess: (content: string) => Promise<DirectCandidateAssessment>;
  runContextFreeRetry: () => Promise<TextGenerationResponse>;
  buildFallback: (assessment: DirectCandidateAssessment) => string;
}): Promise<DirectResponseRecoveryResult> {
  const primaryAssessment = await params.assess(params.primaryResponse.content);
  if (!isDirectCandidateRejected(primaryAssessment) || params.inputSafetyAction !== 'allow') {
    return {
      response: params.primaryResponse,
      assessment: primaryAssessment,
      originalAssessment: null,
      originalContent: null,
      retryCount: 0,
      retrySucceeded: false
    };
  }

  const retryResponse = await params.runContextFreeRetry();
  const retryAssessment = await params.assess(retryResponse.content);
  const retrySucceeded = !isDirectCandidateRejected(retryAssessment);
  return {
    response: {
      ...retryResponse,
      content: retrySucceeded ? retryResponse.content : params.buildFallback(retryAssessment),
      usage: mergeTextGenerationUsage(params.primaryResponse.usage, retryResponse.usage)
    },
    assessment: retryAssessment,
    originalAssessment: primaryAssessment,
    originalContent: params.primaryResponse.content,
    retryCount: 1,
    retrySucceeded
  };
}
