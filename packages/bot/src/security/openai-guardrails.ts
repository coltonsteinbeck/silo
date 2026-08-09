import OpenAI from 'openai';
import { logger } from '@silo/core';
import { deploymentDetector } from './deployment';
import { hashPrompt } from './prompt-policy';
import { evaluatePromptSafety, type PromptSafetyResult } from './prompt-safety';

type GuardrailsModule = typeof import('@openai/guardrails');
type GuardrailsRunner = Pick<GuardrailsModule, 'runGuardrails'>;

type PipelineKey = 'user_prompt' | 'user_jailbreak' | 'custom_prompt' | 'assistant_output';

interface GuardrailsCheckOptions {
  failClosedOnError?: boolean;
  source?: string;
  userId?: string;
}

export interface GuardrailsPromptDecision {
  allowed: boolean;
  category?: string;
  reason?: string;
  executionFailed?: boolean;
  evaluated?: boolean;
}

interface GuardrailSpec {
  name: string;
  config: Record<string, unknown>;
}

const DEFAULT_GUARDRAILS_MODEL = 'gpt-4.1-mini';
const DEFAULT_JAILBREAK_THRESHOLD = 0.7;
const DEFAULT_CONTENT_THRESHOLD = 0.7;
const DEFAULT_MAX_TURNS = 1;
const DEFAULT_CUSTOM_PROMPT_CACHE_TTL_MS = 15 * 60 * 1000;
const LOW_RISK_INPUT_MAX_CHARS = 80;
const LOW_RISK_INPUT_MAX_WORDS = 6;
const DEFAULT_CUSTOM_PROMPT_WARMUP_TEXT = 'You are a helpful Discord assistant.';
const DEFAULT_ASSISTANT_OUTPUT_WARMUP_TEXT = 'Hello! How can I help you today?';

const SUSPICIOUS_SHORT_PROMPT_PATTERN =
  /ignore|forget|disregard|override|system\s*:|\[system\]|instruction|prompt|developer|jailbreak|roleplay|pretend\s+you\s+are|reveal|show\s+the\s+prompt|show\s+the\s+instructions/i;

const USER_PROMPT_PIPELINE: PipelineKey = 'user_prompt';
const USER_JAILBREAK_PIPELINE: PipelineKey = 'user_jailbreak';
const CUSTOM_PROMPT_PIPELINE: PipelineKey = 'custom_prompt';
const ASSISTANT_OUTPUT_PIPELINE: PipelineKey = 'assistant_output';

const MODERATION_CATEGORIES = [
  'sexual',
  'sexual/minors',
  'hate',
  'hate/threatening',
  'harassment',
  'harassment/threatening',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'violence',
  'violence/graphic',
  'illicit',
  'illicit/violent'
] as const;

let warnedMissingApiKey = false;
let guardrailsModulePromise: Promise<GuardrailsRunner> | null = null;
let guardrailLlmClientPromise: Promise<OpenAI> | null = null;
const guardrailBundleCache = new Map<
  PipelineKey,
  { version: number; guardrails: GuardrailSpec[] }
>();
const customPromptDecisionCache = new Map<
  string,
  { decision: GuardrailsPromptDecision; expiresAt: number }
>();

export function resetGuardrailsRuntimeForTests(): void {
  warnedMissingApiKey = false;
  guardrailsModulePromise = null;
  guardrailLlmClientPromise = null;
  guardrailBundleCache.clear();
  customPromptDecisionCache.clear();
}

export function setGuardrailsRuntimeForTests(params: {
  module?: GuardrailsRunner;
  guardrailLlmClient?: OpenAI;
}): void {
  guardrailsModulePromise = params.module ? Promise.resolve(params.module) : null;
  guardrailLlmClientPromise = params.guardrailLlmClient
    ? Promise.resolve(params.guardrailLlmClient)
    : null;
}

function parseThreshold(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseMaxTurns(value: string | undefined): number {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_TURNS;
  }

  const clamped = Math.trunc(parsed);
  return Math.min(10, Math.max(1, clamped));
}

function buildLlmConfig(
  model: string,
  threshold: number,
  maxTurns: number
): Record<string, unknown> {
  return {
    model,
    confidence_threshold: threshold,
    include_reasoning: false,
    max_turns: maxTurns
  };
}

function getContentThreshold(pipeline: PipelineKey): number {
  if (pipeline === ASSISTANT_OUTPUT_PIPELINE) {
    return parseThreshold(
      process.env.OPENAI_GUARDRAILS_OUTPUT_THRESHOLD,
      parseThreshold(
        process.env.OPENAI_GUARDRAILS_CUSTOM_PROMPT_THRESHOLD,
        DEFAULT_CONTENT_THRESHOLD
      )
    );
  }

  if (pipeline === USER_PROMPT_PIPELINE) {
    return parseThreshold(
      process.env.OPENAI_GUARDRAILS_INPUT_THRESHOLD,
      parseThreshold(
        process.env.OPENAI_GUARDRAILS_CUSTOM_PROMPT_THRESHOLD,
        DEFAULT_CONTENT_THRESHOLD
      )
    );
  }

  return parseThreshold(
    process.env.OPENAI_GUARDRAILS_CUSTOM_PROMPT_THRESHOLD,
    DEFAULT_CONTENT_THRESHOLD
  );
}

function buildGuardrailBundle(pipeline: PipelineKey): {
  version: number;
  guardrails: GuardrailSpec[];
} {
  const model = process.env.OPENAI_GUARDRAILS_MODEL || DEFAULT_GUARDRAILS_MODEL;
  const jailbreakThreshold = parseThreshold(
    process.env.OPENAI_GUARDRAILS_JAILBREAK_THRESHOLD,
    DEFAULT_JAILBREAK_THRESHOLD
  );
  const contentThreshold = getContentThreshold(pipeline);
  const maxTurns = parseMaxTurns(process.env.OPENAI_GUARDRAILS_MAX_TURNS);

  if (pipeline === USER_JAILBREAK_PIPELINE) {
    return {
      version: 1,
      guardrails: [
        {
          name: 'Jailbreak',
          config: buildLlmConfig(model, jailbreakThreshold, maxTurns)
        }
      ]
    };
  }

  const guardrails: GuardrailSpec[] = [
    {
      name: 'NSFW Text',
      config: buildLlmConfig(model, contentThreshold, 1)
    },
    {
      name: 'Moderation',
      config: {
        categories: [...MODERATION_CATEGORIES]
      }
    }
  ];

  if (pipeline !== ASSISTANT_OUTPUT_PIPELINE) {
    guardrails.unshift({
      name: 'Jailbreak',
      config: buildLlmConfig(model, jailbreakThreshold, maxTurns)
    });
  }

  return {
    version: 1,
    guardrails
  };
}

function getGuardrailBundle(pipeline: PipelineKey): {
  version: number;
  guardrails: GuardrailSpec[];
} {
  const existing = guardrailBundleCache.get(pipeline);
  if (existing) {
    return existing;
  }

  const bundle = buildGuardrailBundle(pipeline);
  guardrailBundleCache.set(pipeline, bundle);
  return bundle;
}

async function getGuardrailsModule(): Promise<GuardrailsRunner> {
  if (!guardrailsModulePromise) {
    guardrailsModulePromise = import('@openai/guardrails').then(module => ({
      runGuardrails: module.runGuardrails
    }));
  }

  return guardrailsModulePromise;
}

async function getGuardrailLlmClient(): Promise<OpenAI> {
  if (guardrailLlmClientPromise) {
    return guardrailLlmClientPromise;
  }

  guardrailLlmClientPromise = (async () => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for OpenAI Guardrails checks');
    }

    const baseURL = process.env.OPENAI_GUARDRAILS_BASE_URL;
    return new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
  })();

  return guardrailLlmClientPromise;
}

export function isGuardrailsEnabled(): boolean {
  const configured = process.env.OPENAI_GUARDRAILS_ENABLED?.trim().toLowerCase();
  if (configured === 'true') {
    return true;
  }
  if (configured === 'false') {
    return false;
  }

  return deploymentDetector.getConfig().isProduction;
}

function shouldRaiseGuardrailErrors(): boolean {
  const configured = process.env.OPENAI_GUARDRAILS_STRICT;
  if (configured === 'true') {
    return true;
  }
  if (configured === 'false') {
    return false;
  }

  return deploymentDetector.getConfig().isProduction;
}

function shouldFailClosed(options: GuardrailsCheckOptions): boolean {
  if (typeof options.failClosedOnError === 'boolean') {
    return options.failClosedOnError;
  }

  return shouldRaiseGuardrailErrors();
}

function getCustomPromptCacheTtlMs(): number {
  const parsed = Number(process.env.OPENAI_GUARDRAILS_CUSTOM_PROMPT_CACHE_TTL_MS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CUSTOM_PROMPT_CACHE_TTL_MS;
  }

  return Math.max(0, Math.trunc(parsed));
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function shouldUseLowRiskUserPromptFastPath(text: string): boolean {
  if (!parseBoolean(process.env.OPENAI_GUARDRAILS_INPUT_FAST_PATH, true)) {
    return false;
  }

  if (text.length > LOW_RISK_INPUT_MAX_CHARS) {
    return false;
  }

  if (countWords(text) > LOW_RISK_INPUT_MAX_WORDS) {
    return false;
  }

  return !SUSPICIOUS_SHORT_PROMPT_PATTERN.test(text);
}

function getCachedCustomPromptDecision(prompt: string): GuardrailsPromptDecision | null {
  const ttlMs = getCustomPromptCacheTtlMs();
  if (ttlMs <= 0) {
    return null;
  }

  const cacheKey = hashPrompt(prompt);
  const cached = customPromptDecisionCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    customPromptDecisionCache.delete(cacheKey);
    return null;
  }

  return cached.decision;
}

function cacheCustomPromptDecision(prompt: string, decision: GuardrailsPromptDecision): void {
  const ttlMs = getCustomPromptCacheTtlMs();
  if (ttlMs <= 0 || decision.executionFailed) {
    return;
  }

  customPromptDecisionCache.set(hashPrompt(prompt), {
    decision,
    expiresAt: Date.now() + ttlMs
  });
}

function extractGuardrailName(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const info = (result as { info?: Record<string, unknown> }).info;
  if (!info || typeof info !== 'object') {
    return undefined;
  }

  return typeof info.guardrail_name === 'string' ? info.guardrail_name : undefined;
}

function extractGuardrailReason(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const info = (result as { info?: Record<string, unknown> }).info;
  if (!info || typeof info !== 'object') {
    return undefined;
  }

  if (typeof info.reason === 'string') {
    return info.reason;
  }

  if (Array.isArray(info.flagged_categories) && info.flagged_categories.length > 0) {
    return String(info.flagged_categories.join(', '));
  }

  if (typeof info.error === 'string') {
    return info.error;
  }

  return undefined;
}

function mapTripwireCategory(pipeline: PipelineKey, guardrailName: string | undefined): string {
  const normalized = (guardrailName || '').toLowerCase();

  if (normalized.includes('jailbreak')) {
    return 'guardrails/jailbreak';
  }

  if (normalized.includes('nsfw')) {
    return pipeline === ASSISTANT_OUTPUT_PIPELINE ? 'guardrails/output_nsfw' : 'guardrails/nsfw';
  }

  if (normalized.includes('moderation')) {
    return pipeline === ASSISTANT_OUTPUT_PIPELINE
      ? 'guardrails/output_moderation'
      : 'guardrails/moderation';
  }

  if (pipeline === CUSTOM_PROMPT_PIPELINE) {
    return 'guardrails/custom_prompt_blocked';
  }

  if (pipeline === ASSISTANT_OUTPUT_PIPELINE) {
    return 'guardrails/output_blocked';
  }

  return 'guardrails/input_blocked';
}

function toTripwireDecision(pipeline: PipelineKey, result: unknown): GuardrailsPromptDecision {
  const guardrailName = extractGuardrailName(result);
  return {
    allowed: false,
    category: mapTripwireCategory(pipeline, guardrailName),
    reason: extractGuardrailReason(result),
    evaluated: true
  };
}

function toPromptSafetyDecision(
  result: PromptSafetyResult,
  options: GuardrailsCheckOptions = {}
): GuardrailsPromptDecision {
  const executionFailed = Boolean(result.moderationError);

  if (options.failClosedOnError && executionFailed) {
    return {
      allowed: false,
      category: 'guardrails/api_error_fail_closed',
      reason: result.moderationError || 'Prompt safety moderation failed',
      executionFailed: true,
      evaluated: result.moderationEvaluated
    };
  }

  if (result.allowed) {
    return {
      allowed: true,
      executionFailed,
      evaluated: result.moderationEvaluated
    };
  }

  if (result.reasons.includes('prompt_injection/policy_bypass')) {
    return {
      allowed: false,
      category: 'guardrails/jailbreak',
      reason: result.reasons.join(', '),
      executionFailed,
      evaluated: result.moderationEvaluated
    };
  }

  if (result.moderationCategories.length > 0) {
    return {
      allowed: false,
      category:
        result.profile === ASSISTANT_OUTPUT_PIPELINE_PROFILE
          ? 'guardrails/output_moderation'
          : 'guardrails/moderation',
      reason: result.moderationCategories.join(', '),
      executionFailed,
      evaluated: result.moderationEvaluated
    };
  }

  return {
    allowed: false,
    category:
      result.profile === ASSISTANT_OUTPUT_PIPELINE_PROFILE
        ? 'guardrails/output_blocked'
        : 'guardrails/input_blocked',
    reason: result.reasons.join(', '),
    executionFailed,
    evaluated: result.moderationEvaluated
  };
}

const USER_PROMPT_PIPELINE_PROFILE = 'chat_input';
const ASSISTANT_OUTPUT_PIPELINE_PROFILE = 'assistant_output';

async function evaluateWithPipeline(
  pipeline: PipelineKey,
  text: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  if (!isGuardrailsEnabled()) {
    return { allowed: true, evaluated: false };
  }

  const failClosed = shouldFailClosed(options);

  if (!process.env.OPENAI_API_KEY) {
    if (!warnedMissingApiKey) {
      logger.warn('OPENAI_GUARDRAILS_ENABLED is true but OPENAI_API_KEY is not configured');
      warnedMissingApiKey = true;
    }

    if (failClosed) {
      return {
        allowed: false,
        category: 'guardrails/api_error_fail_closed',
        reason: 'Guardrails API key missing',
        executionFailed: true,
        evaluated: true
      };
    }

    return {
      allowed: true,
      executionFailed: true,
      evaluated: true
    };
  }

  try {
    const [module, client] = await Promise.all([getGuardrailsModule(), getGuardrailLlmClient()]);
    const raiseGuardrailErrors = shouldRaiseGuardrailErrors() && !failClosed;

    const context = {
      guardrailLlm: client,
      conversationHistory: [{ role: 'user', content: text }]
    };

    const results = await module.runGuardrails(
      text,
      getGuardrailBundle(pipeline),
      context,
      raiseGuardrailErrors
    );

    const triggeredResult = results.find(result => result.tripwireTriggered);
    if (triggeredResult) {
      return toTripwireDecision(pipeline, triggeredResult);
    }

    const failedResult = results.find(result => result.executionFailed);
    if (failedResult) {
      logger.warn('OpenAI Guardrails execution had failures', {
        pipeline,
        reason: extractGuardrailReason(failedResult)
      });

      if (failClosed) {
        return {
          allowed: false,
          category: 'guardrails/api_error_fail_closed',
          reason: extractGuardrailReason(failedResult) || 'Guardrails execution failed',
          executionFailed: true,
          evaluated: true
        };
      }

      return {
        allowed: true,
        executionFailed: true,
        evaluated: true
      };
    }

    return { allowed: true, evaluated: true };
  } catch (error) {
    logger.error('OpenAI Guardrails execution failed', {
      pipeline,
      error
    });

    if (failClosed) {
      return {
        allowed: false,
        category: 'guardrails/api_error_fail_closed',
        reason: 'Guardrails execution failed',
        executionFailed: true,
        evaluated: true
      };
    }

    return {
      allowed: true,
      executionFailed: true,
      evaluated: true
    };
  }
}

export async function evaluateUserPromptGuardrails(
  prompt: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  const normalized = prompt.trim();
  if (!normalized) {
    return { allowed: true };
  }

  const result = await evaluatePromptSafety(normalized, {
    profile: USER_PROMPT_PIPELINE_PROFILE,
    source: options.source || USER_PROMPT_PIPELINE,
    userId: options.userId
  });

  if (options.failClosedOnError && result.moderationError) {
    return {
      allowed: false,
      category: 'guardrails/api_error_fail_closed',
      reason: result.moderationError,
      executionFailed: true
    };
  }

  if (shouldUseLowRiskUserPromptFastPath(normalized) && result.allowed) {
    return { allowed: true, executionFailed: Boolean(result.moderationError) };
  }

  return toPromptSafetyDecision(result, options);
}

export async function evaluateCustomSystemPromptGuardrails(
  prompt: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  const normalized = prompt.trim();
  if (!normalized) {
    return { allowed: true };
  }

  const cached = getCachedCustomPromptDecision(normalized);
  if (cached) {
    return cached;
  }

  const decision = await evaluateWithPipeline(CUSTOM_PROMPT_PIPELINE, normalized, options);
  cacheCustomPromptDecision(normalized, decision);
  return decision;
}

export async function prewarmGuardrailsRuntime(
  params: {
    customPrompts?: string[];
  } = {}
): Promise<void> {
  if (!isGuardrailsEnabled() || !process.env.OPENAI_API_KEY) {
    return;
  }

  await Promise.all([getGuardrailsModule(), getGuardrailLlmClient()]);
  getGuardrailBundle(USER_PROMPT_PIPELINE);
  getGuardrailBundle(CUSTOM_PROMPT_PIPELINE);
  getGuardrailBundle(ASSISTANT_OUTPUT_PIPELINE);

  const customPrompts = Array.from(
    new Set(
      (params.customPrompts || []).map(prompt => prompt.trim()).filter(prompt => prompt.length > 0)
    )
  );

  const warmupTasks: Promise<unknown>[] = [
    evaluateWithPipeline(ASSISTANT_OUTPUT_PIPELINE, DEFAULT_ASSISTANT_OUTPUT_WARMUP_TEXT, {
      failClosedOnError: false
    })
  ];

  if (customPrompts.length > 0) {
    warmupTasks.push(
      ...customPrompts.map(prompt =>
        evaluateCustomSystemPromptGuardrails(prompt, {
          failClosedOnError: false
        })
      )
    );
  } else {
    warmupTasks.push(
      evaluateWithPipeline(CUSTOM_PROMPT_PIPELINE, DEFAULT_CUSTOM_PROMPT_WARMUP_TEXT, {
        failClosedOnError: false
      })
    );
  }

  await Promise.allSettled(warmupTasks);
}

export async function evaluateAssistantOutputGuardrails(
  output: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  const normalized = output.trim();
  if (!normalized) {
    return { allowed: true };
  }

  const result = await evaluatePromptSafety(normalized, {
    profile: ASSISTANT_OUTPUT_PIPELINE_PROFILE,
    source: options.source || ASSISTANT_OUTPUT_PIPELINE,
    userId: options.userId
  });

  return toPromptSafetyDecision(result, options);
}

export async function evaluateSemanticUserPromptGuardrails(
  prompt: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  const normalized = prompt.trim();
  if (!normalized) {
    return { allowed: true };
  }

  return evaluateWithPipeline(USER_JAILBREAK_PIPELINE, normalized, options);
}

export async function evaluateSemanticAssistantOutputGuardrails(
  output: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  const normalized = output.trim();
  if (!normalized) {
    return { allowed: true };
  }

  return evaluateWithPipeline(ASSISTANT_OUTPUT_PIPELINE, normalized, options);
}
