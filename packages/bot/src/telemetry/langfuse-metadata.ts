import crypto from 'node:crypto';
import { logger } from '@silo/core';
import type { TraceMetadata, TraceMetadataValue } from './langfuse-client';

const LOCAL_HASH_SALT_FALLBACK = 'silo-local-langfuse-salt';

export type SiloMessageType =
  | 'discord-message'
  | 'slash-command'
  | 'button-interaction'
  | 'modal-interaction'
  | 'select-menu-interaction'
  | 'scheduled-job'
  | 'system-event'
  | string;

export type LangfuseMetadataInput = {
  appName?: string;
  appEnv?: string;
  hostName?: string;
  release?: string;
  releaseCommit?: string;
  promptVersion?: string;

  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  interactionId?: string | null;

  messageType?: SiloMessageType;
  commandName?: string | null;

  provider?: string | null;
  model?: string | null;
  adapter?: string | null;

  routerDecision?: string | null;
  routerReason?: string | null;

  hasConversationHistory?: boolean;
  conversationMessageCount?: number;
  contextScope?: string | null;
  contextSelectedTurnCount?: number;
  contextSelectedMessageCount?: number;
  contextTurnBudget?: number;
  contextMessageBudget?: number;
  contextExcludedTurnCount?: number;
  contextExclusionReasons?: string[];
  inputSafetyAction?: string | null;
  inputSafetyDetectorSources?: string[];
  inputContextEligible?: boolean;
  inheritedContextSafetyRisk?: boolean;
  contextSafetyAction?: string | null;
  contextSafetyCategories?: string[];
  contextSafetyDetectorSources?: string[];
  modelCircuitFailureCount?: number;
  modelCircuitActivated?: boolean;
  modelCircuitContextDisabled?: boolean;
  modelCircuitContextDisabledUntil?: string | null;

  usesTools?: boolean;
  toolsAvailable?: string[];
  toolsCalled?: string[];

  supportsImages?: boolean;
  supportsVideo?: boolean;
  supportsAudio?: boolean;
  isLocalModel?: boolean;

  promptHash?: string | null;
  customPromptHash?: string | null;
  promptSource?: string | null;
  promptFallbackReason?: string | null;
  promptEnabled?: boolean;
  promptUpdatedAt?: string | null;
  promptRevision?: string | number | null;

  graphName?: string | null;
  graphVersion?: string | null;
  graphNode?: string | null;
  graphStep?: number | null;
  graphRecursionLimit?: number | null;
  intent?: string | null;
  intentConfidence?: number | null;
  intentReason?: string | null;
  questionType?: string | null;
  questionCount?: number | null;
  searchableQuestionCount?: number | null;
  conversationalQuestionCount?: number | null;
  requestedTools?: string[];
  toolBudget?: Record<string, number | string | boolean | null> | null;
  toolsAllowed?: string[];
  searchProvider?: string | null;
  searchQuery?: string | null;
  searchResultCount?: number | null;
  sourceDomains?: string[];
  mediaProvider?: string | null;
  mediaModel?: string | null;
  falsePositiveGuard?: string | null;
  safetyState?: string | null;
  graphOutcome?: string | null;
  temperature?: number;
  generationSource?: string | null;
  configuredMaxOutputTokens?: number;
  effectiveMaxOutputTokens?: number;
  completionTokens?: number;
  finishReason?: string | null;
  providerFinishReason?: string | null;
  recoveryAttempt?: number;
  recoveryContextFree?: boolean;
  recoveryReason?: string | null;
  recoveryContextRetained?: boolean;
  deliveryTruncated?: boolean;
};

type LangfuseMetadataDefaults = Pick<
  LangfuseMetadataInput,
  'appName' | 'appEnv' | 'hostName' | 'release' | 'releaseCommit' | 'promptVersion'
> & {
  userHashSalt?: string;
};

let metadataDefaults: LangfuseMetadataDefaults = {};
let warnedAboutMissingHashSalt = false;

export function configureLangfuseMetadataDefaults(defaults: LangfuseMetadataDefaults): void {
  metadataDefaults = {
    ...metadataDefaults,
    appName: normalizeOptionalString(defaults.appName) ?? metadataDefaults.appName,
    appEnv: normalizeOptionalString(defaults.appEnv) ?? metadataDefaults.appEnv,
    hostName: normalizeOptionalString(defaults.hostName) ?? metadataDefaults.hostName,
    release: normalizeOptionalString(defaults.release) ?? metadataDefaults.release,
    releaseCommit:
      normalizeOptionalString(defaults.releaseCommit) ?? metadataDefaults.releaseCommit,
    promptVersion:
      normalizeOptionalString(defaults.promptVersion) ?? metadataDefaults.promptVersion,
    userHashSalt: normalizeOptionalString(defaults.userHashSalt) ?? metadataDefaults.userHashSalt
  };
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveReleaseCommitFromEnvironment(): string | undefined {
  const candidates = [
    process.env.RELEASE_COMMIT,
    process.env.GITHUB_SHA,
    process.env.CI_COMMIT_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.RAILWAY_GIT_COMMIT_SHA,
    process.env.RENDER_GIT_COMMIT,
    process.env.SOURCE_VERSION,
    process.env.GIT_COMMIT
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeFiniteNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.trunc(value));
}

function normalizeFiniteDecimal(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeStringArray(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map(value => normalizeOptionalString(value))
        .filter((value): value is string => Boolean(value))
    )
  );
}

function normalizeTagValue(value: string | null | undefined): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeProvider(value: string | null | undefined): string | undefined {
  const normalized = normalizeTagValue(value);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case 'openai':
    case 'anthropic':
    case 'xai':
    case 'google':
    case 'ollama':
    case 'local':
      return normalized;
    case 'local-openai':
    case 'lm-studio':
    case 'lmstudio':
      return 'local';
    default:
      return normalized;
  }
}

function resolvePlatformTag(messageType: SiloMessageType | undefined): string | undefined {
  const normalized = normalizeTagValue(messageType);
  if (!normalized) {
    return undefined;
  }

  if (
    normalized === 'discord-message' ||
    normalized === 'slash-command' ||
    normalized === 'button-interaction' ||
    normalized === 'modal-interaction' ||
    normalized === 'select-menu-interaction'
  ) {
    return 'discord';
  }

  if (normalized === 'scheduled-job' || normalized === 'system-event') {
    return 'system';
  }

  return normalized.startsWith('discord') || normalized.includes('interaction')
    ? 'discord'
    : undefined;
}

function resolveDefaultAppName(): string {
  return metadataDefaults.appName || normalizeOptionalString(process.env.APP_NAME) || 'silo';
}

function resolveDefaultAppEnv(): string {
  return (
    metadataDefaults.appEnv ||
    normalizeOptionalString(process.env.APP_ENV) ||
    normalizeOptionalString(process.env.NODE_ENV) ||
    'development'
  );
}

function isLocalDevelopmentEnvironment(): boolean {
  const appEnv = resolveDefaultAppEnv().toLowerCase();
  return appEnv === 'development' || appEnv === 'dev' || appEnv === 'local';
}

function resolveHashSalt(): string {
  const configuredSalt =
    metadataDefaults.userHashSalt || normalizeOptionalString(process.env.LANGFUSE_USER_HASH_SALT);
  if (configuredSalt) {
    return configuredSalt;
  }

  if (!warnedAboutMissingHashSalt) {
    warnedAboutMissingHashSalt = true;
    logger.warn(
      isLocalDevelopmentEnvironment()
        ? 'LANGFUSE_USER_HASH_SALT is not set; using a local development fallback for Discord user hashing.'
        : 'LANGFUSE_USER_HASH_SALT is not set; using a deterministic fallback for Discord user hashing. Configure the salt to keep hashes stable and private.'
    );
  }

  if (isLocalDevelopmentEnvironment()) {
    return LOCAL_HASH_SALT_FALLBACK;
  }

  return `silo:${metadataDefaults.release || normalizeOptionalString(process.env.LANGFUSE_RELEASE) || metadataDefaults.hostName || normalizeOptionalString(process.env.HOST_NAME) || 'missing-langfuse-salt'}`;
}

function addMetadataField(
  metadata: TraceMetadata,
  key: string,
  value: TraceMetadataValue | undefined
): void {
  if (value !== undefined) {
    metadata[key] = value;
  }
}

export function buildLangfuseTraceMetadata(input: LangfuseMetadataInput): TraceMetadata {
  const metadata: TraceMetadata = {};
  const provider = normalizeProvider(input.provider);
  const commandName =
    normalizeOptionalString(input.commandName) ||
    (input.messageType === 'discord-message' ? 'message' : undefined);
  const conversationMessageCount = normalizeFiniteNumber(input.conversationMessageCount);

  addMetadataField(metadata, 'app', resolveDefaultAppName());
  addMetadataField(
    metadata,
    'environment',
    normalizeOptionalString(input.appEnv) || resolveDefaultAppEnv()
  );
  addMetadataField(
    metadata,
    'host',
    normalizeOptionalString(input.hostName) ||
      metadataDefaults.hostName ||
      normalizeOptionalString(process.env.HOST_NAME)
  );
  addMetadataField(
    metadata,
    'release',
    normalizeOptionalString(input.release) ||
      metadataDefaults.release ||
      normalizeOptionalString(process.env.LANGFUSE_RELEASE)
  );
  addMetadataField(
    metadata,
    'releaseCommit',
    normalizeOptionalString(input.releaseCommit) ||
      metadataDefaults.releaseCommit ||
      resolveReleaseCommitFromEnvironment()
  );
  addMetadataField(
    metadata,
    'promptVersion',
    normalizeOptionalString(input.promptVersion) ||
      metadataDefaults.promptVersion ||
      normalizeOptionalString(process.env.PROMPT_VERSION)
  );

  addMetadataField(metadata, 'discordGuildId', normalizeOptionalString(input.guildId));
  addMetadataField(metadata, 'discordChannelId', normalizeOptionalString(input.channelId));
  addMetadataField(metadata, 'discordMessageId', normalizeOptionalString(input.messageId));
  addMetadataField(metadata, 'discordInteractionId', normalizeOptionalString(input.interactionId));

  addMetadataField(metadata, 'messageType', normalizeTagValue(input.messageType));
  addMetadataField(metadata, 'commandName', commandName);
  addMetadataField(metadata, 'provider', provider);
  addMetadataField(metadata, 'model', normalizeOptionalString(input.model));
  addMetadataField(metadata, 'adapter', normalizeTagValue(input.adapter));
  addMetadataField(metadata, 'routerDecision', normalizeOptionalString(input.routerDecision));
  addMetadataField(metadata, 'routerReason', normalizeOptionalString(input.routerReason));

  if (typeof input.hasConversationHistory === 'boolean') {
    addMetadataField(metadata, 'hasConversationHistory', input.hasConversationHistory);
  }

  addMetadataField(metadata, 'conversationMessageCount', conversationMessageCount);
  addMetadataField(metadata, 'contextScope', normalizeTagValue(input.contextScope));
  addMetadataField(
    metadata,
    'contextSelectedTurnCount',
    normalizeFiniteNumber(input.contextSelectedTurnCount)
  );
  addMetadataField(
    metadata,
    'contextSelectedMessageCount',
    normalizeFiniteNumber(input.contextSelectedMessageCount)
  );
  addMetadataField(metadata, 'contextTurnBudget', normalizeFiniteNumber(input.contextTurnBudget));
  addMetadataField(
    metadata,
    'contextMessageBudget',
    normalizeFiniteNumber(input.contextMessageBudget)
  );
  addMetadataField(
    metadata,
    'contextExcludedTurnCount',
    normalizeFiniteNumber(input.contextExcludedTurnCount)
  );
  if (input.contextExclusionReasons) {
    addMetadataField(
      metadata,
      'contextExclusionReasons',
      normalizeStringArray(input.contextExclusionReasons)
    );
  }
  addMetadataField(metadata, 'inputSafetyAction', normalizeTagValue(input.inputSafetyAction));
  if (input.inputSafetyDetectorSources) {
    addMetadataField(
      metadata,
      'inputSafetyDetectorSources',
      normalizeStringArray(input.inputSafetyDetectorSources)
    );
  }
  if (typeof input.inputContextEligible === 'boolean') {
    addMetadataField(metadata, 'inputContextEligible', input.inputContextEligible);
  }
  if (typeof input.inheritedContextSafetyRisk === 'boolean') {
    addMetadataField(metadata, 'inheritedContextSafetyRisk', input.inheritedContextSafetyRisk);
  }
  addMetadataField(metadata, 'contextSafetyAction', normalizeTagValue(input.contextSafetyAction));
  if (input.contextSafetyCategories) {
    addMetadataField(
      metadata,
      'contextSafetyCategories',
      normalizeStringArray(input.contextSafetyCategories)
    );
  }
  if (input.contextSafetyDetectorSources) {
    addMetadataField(
      metadata,
      'contextSafetyDetectorSources',
      normalizeStringArray(input.contextSafetyDetectorSources)
    );
  }
  addMetadataField(
    metadata,
    'modelCircuitFailureCount',
    normalizeFiniteNumber(input.modelCircuitFailureCount)
  );
  if (typeof input.modelCircuitActivated === 'boolean') {
    addMetadataField(metadata, 'modelCircuitActivated', input.modelCircuitActivated);
  }
  if (typeof input.modelCircuitContextDisabled === 'boolean') {
    addMetadataField(metadata, 'modelCircuitContextDisabled', input.modelCircuitContextDisabled);
  }
  addMetadataField(
    metadata,
    'modelCircuitContextDisabledUntil',
    normalizeOptionalString(input.modelCircuitContextDisabledUntil)
  );

  if (typeof input.usesTools === 'boolean') {
    addMetadataField(metadata, 'usesTools', input.usesTools);
  }

  if (input.toolsAvailable) {
    addMetadataField(metadata, 'toolsAvailable', normalizeStringArray(input.toolsAvailable));
  }

  if (input.toolsCalled) {
    addMetadataField(metadata, 'toolsCalled', normalizeStringArray(input.toolsCalled));
  }

  if (typeof input.supportsImages === 'boolean') {
    addMetadataField(metadata, 'supportsImages', input.supportsImages);
  }

  if (typeof input.supportsVideo === 'boolean') {
    addMetadataField(metadata, 'supportsVideo', input.supportsVideo);
  }

  if (typeof input.supportsAudio === 'boolean') {
    addMetadataField(metadata, 'supportsAudio', input.supportsAudio);
  }

  if (typeof input.isLocalModel === 'boolean') {
    addMetadataField(metadata, 'isLocalModel', input.isLocalModel);
  }

  addMetadataField(metadata, 'promptHash', normalizeOptionalString(input.promptHash));
  addMetadataField(metadata, 'customPromptHash', normalizeOptionalString(input.customPromptHash));
  addMetadataField(metadata, 'promptSource', normalizeTagValue(input.promptSource));
  addMetadataField(
    metadata,
    'promptFallbackReason',
    normalizeOptionalString(input.promptFallbackReason)
  );

  if (typeof input.promptEnabled === 'boolean') {
    addMetadataField(metadata, 'promptEnabled', input.promptEnabled);
  }

  addMetadataField(metadata, 'promptUpdatedAt', normalizeOptionalString(input.promptUpdatedAt));
  addMetadataField(
    metadata,
    'promptRevision',
    typeof input.promptRevision === 'number'
      ? normalizeFiniteNumber(input.promptRevision)
      : normalizeOptionalString(
          typeof input.promptRevision === 'string' ? input.promptRevision : undefined
        )
  );

  addMetadataField(metadata, 'graphName', normalizeOptionalString(input.graphName));
  addMetadataField(metadata, 'graphVersion', normalizeOptionalString(input.graphVersion));
  addMetadataField(metadata, 'graphNode', normalizeTagValue(input.graphNode));
  addMetadataField(
    metadata,
    'graphStep',
    typeof input.graphStep === 'number' ? normalizeFiniteNumber(input.graphStep) : undefined
  );
  addMetadataField(
    metadata,
    'graphRecursionLimit',
    typeof input.graphRecursionLimit === 'number'
      ? normalizeFiniteNumber(input.graphRecursionLimit)
      : undefined
  );
  addMetadataField(metadata, 'intent', normalizeTagValue(input.intent));
  addMetadataField(
    metadata,
    'intentConfidence',
    typeof input.intentConfidence === 'number' ? input.intentConfidence : undefined
  );
  addMetadataField(metadata, 'intentReason', normalizeOptionalString(input.intentReason));
  addMetadataField(metadata, 'questionType', normalizeTagValue(input.questionType));
  addMetadataField(
    metadata,
    'questionCount',
    typeof input.questionCount === 'number' ? normalizeFiniteNumber(input.questionCount) : undefined
  );
  addMetadataField(
    metadata,
    'searchableQuestionCount',
    typeof input.searchableQuestionCount === 'number'
      ? normalizeFiniteNumber(input.searchableQuestionCount)
      : undefined
  );
  addMetadataField(
    metadata,
    'conversationalQuestionCount',
    typeof input.conversationalQuestionCount === 'number'
      ? normalizeFiniteNumber(input.conversationalQuestionCount)
      : undefined
  );
  if (input.requestedTools) {
    addMetadataField(metadata, 'requestedTools', normalizeStringArray(input.requestedTools));
  }
  if (input.toolBudget) {
    addMetadataField(metadata, 'toolBudget', input.toolBudget as TraceMetadataValue);
  }
  if (input.toolsAllowed) {
    addMetadataField(metadata, 'toolsAllowed', normalizeStringArray(input.toolsAllowed));
  }
  addMetadataField(metadata, 'searchProvider', normalizeProvider(input.searchProvider));
  addMetadataField(metadata, 'searchQuery', normalizeOptionalString(input.searchQuery));
  addMetadataField(
    metadata,
    'searchResultCount',
    typeof input.searchResultCount === 'number'
      ? normalizeFiniteNumber(input.searchResultCount)
      : undefined
  );
  if (input.sourceDomains) {
    addMetadataField(metadata, 'sourceDomains', normalizeStringArray(input.sourceDomains));
  }
  addMetadataField(metadata, 'mediaProvider', normalizeProvider(input.mediaProvider));
  addMetadataField(metadata, 'mediaModel', normalizeOptionalString(input.mediaModel));
  addMetadataField(metadata, 'falsePositiveGuard', normalizeTagValue(input.falsePositiveGuard));
  addMetadataField(metadata, 'safetyState', normalizeTagValue(input.safetyState));
  addMetadataField(metadata, 'graphOutcome', normalizeTagValue(input.graphOutcome));
  addMetadataField(metadata, 'temperature', normalizeFiniteDecimal(input.temperature));
  addMetadataField(metadata, 'generationSource', normalizeTagValue(input.generationSource));
  addMetadataField(
    metadata,
    'configuredMaxOutputTokens',
    normalizeFiniteNumber(input.configuredMaxOutputTokens)
  );
  addMetadataField(
    metadata,
    'effectiveMaxOutputTokens',
    normalizeFiniteNumber(input.effectiveMaxOutputTokens)
  );
  addMetadataField(metadata, 'completionTokens', normalizeFiniteNumber(input.completionTokens));
  addMetadataField(metadata, 'finishReason', normalizeTagValue(input.finishReason));
  addMetadataField(
    metadata,
    'providerFinishReason',
    normalizeOptionalString(input.providerFinishReason)
  );
  addMetadataField(metadata, 'recoveryAttempt', normalizeFiniteNumber(input.recoveryAttempt));
  if (typeof input.recoveryContextFree === 'boolean') {
    addMetadataField(metadata, 'recoveryContextFree', input.recoveryContextFree);
  }
  addMetadataField(metadata, 'recoveryReason', normalizeTagValue(input.recoveryReason));
  if (typeof input.recoveryContextRetained === 'boolean') {
    addMetadataField(metadata, 'recoveryContextRetained', input.recoveryContextRetained);
  }
  if (typeof input.deliveryTruncated === 'boolean') {
    addMetadataField(metadata, 'deliveryTruncated', input.deliveryTruncated);
  }

  return metadata;
}

export function buildLangfuseTags(input: LangfuseMetadataInput): string[] {
  const tags = new Set<string>();
  const appName = normalizeTagValue(input.appName) || normalizeTagValue(resolveDefaultAppName());
  const appEnv = normalizeTagValue(input.appEnv) || normalizeTagValue(resolveDefaultAppEnv());
  const platformTag = resolvePlatformTag(input.messageType);
  const messageType = normalizeTagValue(input.messageType);
  const provider = normalizeProvider(input.provider);
  const model = normalizeTagValue(input.model);

  if (appName) {
    tags.add(appName);
  }

  if (appEnv) {
    tags.add(appEnv);
  }

  if (platformTag) {
    tags.add(platformTag);
  }

  if (messageType) {
    tags.add(messageType);
  }

  if (provider) {
    tags.add(provider);
  }

  if (model) {
    tags.add(model);
  }

  return Array.from(tags);
}

export function hashDiscordUserId(userId: string): string {
  const normalizedUserId = normalizeOptionalString(userId);
  const salt = resolveHashSalt();

  return crypto
    .createHash('sha256')
    .update(`${salt}:${normalizedUserId || 'anonymous'}`)
    .digest('hex');
}
