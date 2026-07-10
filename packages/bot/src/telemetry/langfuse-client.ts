import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  getActiveTraceId,
  propagateAttributes,
  setLangfuseTracerProvider,
  startActiveObservation,
  type LangfuseGeneration,
  type LangfuseGenerationAttributes,
  type LangfuseGuardrail,
  type LangfuseSpan,
  type LangfuseSpanAttributes
} from '@langfuse/tracing';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { logger, type Config } from '@silo/core';

const REDACTED_VALUE = '[redacted]';
const MAX_TRACE_TEXT_LENGTH = 4000;
const MAX_TRACE_PREVIEW_LENGTH = 240;
const MAX_RECURSION_DEPTH = 6;

const SECRET_FIELD_PATTERN =
  /(api[-_]?key|secret|token|password|authorization|cookie|set-cookie|session|credential)/i;

type LangfuseState = {
  enabled: boolean;
  initialized: boolean;
  sampleRate: number;
  provider: NodeTracerProvider | null;
};

export type TraceMetadataValue =
  | string
  | number
  | boolean
  | null
  | TraceMetadataValue[]
  | { [key: string]: TraceMetadataValue };

export type TraceMetadata = Record<string, TraceMetadataValue | undefined>;

type RootTraceOptions = {
  name: string;
  traceName?: string;
  userId?: string;
  sessionId?: string;
  metadata?: TraceMetadata;
  tags?: string[];
  version?: string;
};

type SpanTraceOptions = {
  name: string;
  input?: unknown;
  metadata?: TraceMetadata;
  tags?: string[];
  version?: string;
};

type GuardrailTraceOptions = {
  name: string;
  input?: unknown;
  metadata?: TraceMetadata;
  tags?: string[];
  version?: string;
};

type GenerationTraceOptions = {
  name: string;
  input?: unknown;
  model?: string;
  modelParameters?: Record<string, number | string>;
  metadata?: TraceMetadata;
  tags?: string[];
  version?: string;
};

const state: LangfuseState = {
  enabled: false,
  initialized: false,
  sampleRate: 1,
  provider: null
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sanitizeTraceString(value: string): string {
  const compact = normalizeWhitespace(value);
  const sanitized = compact
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]+/gi, `$1${REDACTED_VALUE}`)
    .replace(/\b(sk|pk)_[A-Za-z0-9_-]+/g, `$1_${REDACTED_VALUE}`)
    .replace(/<@!?\d{15,22}>|<@&\d{15,22}>|<#\d{15,22}>/g, '[discord-id]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?<![\w@])@[A-Za-z0-9._-]{2,32}\b/g, '[user-handle]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip-address]')
    .replace(/(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)/g, '[phone-or-id]')
    .replace(/\b\d{15,22}\b/g, '[discord-id]')
    .replace(/https?:\/\/\S+/gi, rawUrl => {
      try {
        const hostname = new URL(rawUrl).hostname;
        return `[url:${hostname}]`;
      } catch {
        return '[url]';
      }
    });

  return truncate(sanitized, MAX_TRACE_TEXT_LENGTH);
}

function sanitizeTraceValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeTraceString(value);
  }

  if (depth >= MAX_RECURSION_DEPTH) {
    return '[truncated]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map(item => sanitizeTraceValue(item, depth + 1, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[circular]';
    }

    seen.add(value);

    const sanitizedEntries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    return Object.fromEntries(
      sanitizedEntries.map(([key, entryValue]) => {
        if (SECRET_FIELD_PATTERN.test(key)) {
          return [key, REDACTED_VALUE];
        }

        return [key, sanitizeTraceValue(entryValue, depth + 1, seen)];
      })
    );
  }

  return String(value);
}

function sanitizeMetadata(metadata: TraceMetadata | undefined): TraceMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitizedEntries = Object.entries(metadata).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }

    const sanitizedValue = sanitizeTraceValue(value);
    if (sanitizedValue === undefined) {
      return [];
    }

    if (typeof sanitizedValue === 'string') {
      const normalized = truncate(normalizeWhitespace(sanitizedValue), 200);
      if (normalized.length === 0) {
        return [];
      }

      return [[key, normalized] as const];
    }

    return [[key, sanitizedValue as TraceMetadataValue] as const];
  });

  return sanitizedEntries.length > 0 ? Object.fromEntries(sanitizedEntries) : undefined;
}

function shouldSampleTrace(): boolean {
  if (!state.enabled) {
    return false;
  }

  if (state.sampleRate <= 0) {
    return false;
  }

  if (state.sampleRate >= 1) {
    return true;
  }

  return Math.random() < state.sampleRate;
}

function hasActiveTrace(): boolean {
  return state.enabled && Boolean(getActiveTraceId());
}

function updateObservationIfPresent<
  T extends LangfuseSpan | LangfuseGeneration | LangfuseGuardrail
>(observation: T | null, attributes: LangfuseSpanAttributes | LangfuseGenerationAttributes): void {
  if (!observation || Object.keys(attributes).length === 0) {
    return;
  }

  observation.update(attributes as never);
}

export function summarizeTextForTrace(
  value: string | undefined | null,
  maxLength = MAX_TRACE_PREVIEW_LENGTH
): string {
  if (!value) {
    return '';
  }

  return truncate(sanitizeTraceString(value), maxLength);
}

export function initializeLangfuseTracing(config: Config): void {
  if (state.initialized) {
    return;
  }

  state.initialized = true;
  state.sampleRate = config.langfuse.sampleRate;

  if (!config.langfuse.enabled) {
    logger.info('Langfuse tracing disabled');
    return;
  }

  try {
    const spanProcessor = new LangfuseSpanProcessor({
      publicKey: config.langfuse.publicKey,
      secretKey: config.langfuse.secretKey,
      baseUrl: config.langfuse.baseUrl,
      environment: config.langfuse.environment,
      release: config.langfuse.release,
      timeout: config.langfuse.timeout,
      flushAt: config.langfuse.flushAt,
      flushInterval: config.langfuse.flushInterval,
      exportMode: config.langfuse.exportMode,
      mask: ({ data }) => sanitizeTraceValue(data)
    });

    const provider = new NodeTracerProvider({
      spanProcessors: [spanProcessor]
    });

    provider.register({
      contextManager: new AsyncLocalStorageContextManager()
    });
    setLangfuseTracerProvider(provider);

    state.enabled = true;
    state.provider = provider;

    logger.info('Langfuse tracing enabled', {
      baseUrl: config.langfuse.baseUrl,
      environment: config.langfuse.environment,
      release: config.langfuse.release || null,
      sampleRate: config.langfuse.sampleRate,
      exportMode: config.langfuse.exportMode
    });
  } catch (error) {
    state.enabled = false;
    state.provider = null;
    logger.error('Failed to initialize Langfuse tracing', error);
  }
}

export async function shutdownLangfuseTracing(): Promise<void> {
  if (!state.provider) {
    return;
  }

  const provider = state.provider;
  state.provider = null;

  try {
    await provider.shutdown();
    logger.info('Langfuse tracing shut down');
  } catch (error) {
    logger.warn('Failed to shut down Langfuse tracing cleanly', error);
  }
}

export async function withLangfuseRootTrace<T>(
  options: RootTraceOptions,
  fn: (observation: LangfuseSpan | null, traceId: string | null) => Promise<T>
): Promise<T> {
  if (!shouldSampleTrace()) {
    return fn(null, null);
  }

  return startActiveObservation(options.name, async observation => {
    updateObservationIfPresent(observation, {
      metadata: sanitizeMetadata(options.metadata),
      version: options.version
    });

    return propagateAttributes(
      {
        userId: options.userId,
        sessionId: options.sessionId,
        tags: options.tags,
        version: options.version,
        traceName: options.traceName || options.name
      },
      async () => fn(observation, getActiveTraceId() || null)
    );
  });
}

export async function withLangfuseSpan<T>(
  options: SpanTraceOptions,
  fn: (observation: LangfuseSpan | null) => Promise<T>
): Promise<T> {
  if (!hasActiveTrace()) {
    return fn(null);
  }

  const runObservation = async (): Promise<T> =>
    startActiveObservation(options.name, async observation => {
      updateObservationIfPresent(observation, {
        input: sanitizeTraceValue(options.input),
        metadata: sanitizeMetadata(options.metadata),
        version: options.version
      });
      return fn(observation);
    });

  if (options.tags && options.tags.length > 0) {
    return propagateAttributes({ tags: options.tags }, runObservation);
  }

  return runObservation();
}

export async function withLangfuseGuardrail<T>(
  options: GuardrailTraceOptions,
  fn: (observation: LangfuseGuardrail | null) => Promise<T>
): Promise<T> {
  if (!hasActiveTrace()) {
    return fn(null);
  }

  const runObservation = async (): Promise<T> =>
    startActiveObservation(
      options.name,
      async observation => {
        updateObservationIfPresent(observation, {
          input: sanitizeTraceValue(options.input),
          metadata: sanitizeMetadata(options.metadata),
          version: options.version
        });
        return fn(observation);
      },
      { asType: 'guardrail' }
    );

  if (options.tags && options.tags.length > 0) {
    return propagateAttributes({ tags: options.tags }, runObservation);
  }

  return runObservation();
}

export async function withLangfuseGeneration<T>(
  options: GenerationTraceOptions,
  fn: (observation: LangfuseGeneration | null) => Promise<T>
): Promise<T> {
  if (!hasActiveTrace()) {
    return fn(null);
  }

  const runObservation = async (): Promise<T> =>
    startActiveObservation(
      options.name,
      async observation => {
        updateObservationIfPresent(observation, {
          input: sanitizeTraceValue(options.input),
          model: options.model,
          modelParameters: options.modelParameters,
          metadata: sanitizeMetadata(options.metadata),
          version: options.version
        });
        return fn(observation);
      },
      { asType: 'generation' }
    );

  if (options.tags && options.tags.length > 0) {
    return propagateAttributes({ tags: options.tags }, runObservation);
  }

  return runObservation();
}
