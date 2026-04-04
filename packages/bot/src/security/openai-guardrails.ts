import OpenAI from 'openai';
import { logger } from '@silo/core';
import { deploymentDetector } from './deployment';

type GuardrailsModule = typeof import('@openai/guardrails');

type PipelineKey = 'user_prompt' | 'custom_prompt' | 'assistant_output';

interface GuardrailsCheckOptions {
  failClosedOnError?: boolean;
}

export interface GuardrailsPromptDecision {
  allowed: boolean;
  category?: string;
  reason?: string;
  executionFailed?: boolean;
}

interface GuardrailSpec {
  name: string;
  config: Record<string, unknown>;
}

const DEFAULT_GUARDRAILS_MODEL = 'gpt-4.1-mini';
const DEFAULT_JAILBREAK_THRESHOLD = 0.7;
const DEFAULT_CONTENT_THRESHOLD = 0.7;
const DEFAULT_MAX_TURNS = 1;

const USER_PROMPT_PIPELINE: PipelineKey = 'user_prompt';
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
let guardrailsModulePromise: Promise<GuardrailsModule> | null = null;
let guardrailLlmClientPromise: Promise<OpenAI> | null = null;
const guardrailBundleCache = new Map<
  PipelineKey,
  { version: number; guardrails: GuardrailSpec[] }
>();

function parseThreshold(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
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

async function getGuardrailsModule(): Promise<GuardrailsModule> {
  if (!guardrailsModulePromise) {
    guardrailsModulePromise = import('@openai/guardrails') as Promise<GuardrailsModule>;
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
  return process.env.OPENAI_GUARDRAILS_ENABLED === 'true';
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
    reason: extractGuardrailReason(result)
  };
}

async function evaluateWithPipeline(
  pipeline: PipelineKey,
  text: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  if (!isGuardrailsEnabled()) {
    return { allowed: true };
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
        executionFailed: true
      };
    }

    return {
      allowed: true,
      executionFailed: true
    };
  }

  try {
    const [module, client] = await Promise.all([getGuardrailsModule(), getGuardrailLlmClient()]);

    const context = {
      guardrailLlm: client,
      conversationHistory: [{ role: 'user', content: text }]
    };

    const results = await module.runGuardrails(
      text,
      getGuardrailBundle(pipeline),
      context,
      shouldRaiseGuardrailErrors()
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
          executionFailed: true
        };
      }

      return {
        allowed: true,
        executionFailed: true
      };
    }

    return { allowed: true };
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
        executionFailed: true
      };
    }

    return {
      allowed: true,
      executionFailed: true
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

  return evaluateWithPipeline(USER_PROMPT_PIPELINE, normalized, options);
}

export async function evaluateCustomSystemPromptGuardrails(
  prompt: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  const normalized = prompt.trim();
  if (!normalized) {
    return { allowed: true };
  }

  return evaluateWithPipeline(CUSTOM_PROMPT_PIPELINE, normalized, options);
}

export async function evaluateAssistantOutputGuardrails(
  output: string,
  options: GuardrailsCheckOptions = {}
): Promise<GuardrailsPromptDecision> {
  const normalized = output.trim();
  if (!normalized) {
    return { allowed: true };
  }

  return evaluateWithPipeline(ASSISTANT_OUTPUT_PIPELINE, normalized, options);
}
