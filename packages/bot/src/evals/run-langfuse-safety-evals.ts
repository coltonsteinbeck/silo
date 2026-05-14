import { LangfuseAPIClient, NotFoundError } from '@langfuse/core';
import { ConfigLoader, logger, type Config } from '@silo/core';
import { contentSanitizer, evaluateCustomSystemPromptGuardrails } from '../security';
import {
  initializeLangfuseTracing,
  shutdownLangfuseTracing,
  withLangfuseRootTrace
} from '../telemetry/langfuse-client';
import {
  buildLangfuseTags,
  buildLangfuseTraceMetadata,
  configureLangfuseMetadataDefaults
} from '../telemetry/langfuse-metadata';
import {
  buildLangfuseSafetyDatasetDefinition,
  buildLangfuseSafetyScoreRequests,
  compareSafetyEvalResult,
  LANGFUSE_SAFETY_EVAL_DATASET_NAME,
  SAFETY_EVAL_CASES,
  type SafetyEvalActualResult,
  type SafetyEvalCase,
  type LangfuseSafetyEvalScoreRequest
} from './langfuse-safety-evals';

type CliArgs = {
  dryRun: boolean;
  syncDataset: boolean;
  noScores: boolean;
  datasetName?: string;
  caseId?: string;
  tag?: string;
};

type PendingScore = {
  traceId: string;
  score: LangfuseSafetyEvalScoreRequest;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    syncDataset: false,
    noScores: false
  };

  for (const rawArg of argv) {
    if (rawArg === '--dry-run') {
      args.dryRun = true;
      continue;
    }

    if (rawArg === '--sync-dataset') {
      args.syncDataset = true;
      continue;
    }

    if (rawArg === '--no-scores') {
      args.noScores = true;
      continue;
    }

    if (rawArg.startsWith('--dataset-name=')) {
      args.datasetName = rawArg.slice('--dataset-name='.length).trim() || undefined;
      continue;
    }

    if (rawArg.startsWith('--case=')) {
      args.caseId = rawArg.slice('--case='.length).trim() || undefined;
      continue;
    }

    if (rawArg.startsWith('--tag=')) {
      args.tag = rawArg.slice('--tag='.length).trim() || undefined;
    }
  }

  return args;
}

function filterCases(args: CliArgs): SafetyEvalCase[] {
  return SAFETY_EVAL_CASES.filter(testCase => {
    if (args.caseId && testCase.id !== args.caseId) {
      return false;
    }

    if (args.tag && !testCase.tags.includes(args.tag)) {
      return false;
    }

    return true;
  });
}

function createLangfuseApiClient(config: Config): LangfuseAPIClient | null {
  if (!config.langfuse.publicKey || !config.langfuse.secretKey) {
    return null;
  }

  return new LangfuseAPIClient({
    environment: () => config.langfuse.environment,
    baseUrl: () => config.langfuse.baseUrl,
    username: () => config.langfuse.publicKey,
    password: () => config.langfuse.secretKey,
    xLangfuseSdkName: () => 'silo-safety-evals',
    xLangfuseSdkVersion: () => '1'
  });
}

async function syncDataset(
  client: LangfuseAPIClient,
  config: Config,
  datasetName: string,
  dryRun: boolean
): Promise<void> {
  const definition = buildLangfuseSafetyDatasetDefinition({
    name: datasetName,
    release: config.langfuse.release || null,
    promptVersion: process.env.PROMPT_VERSION || null
  });

  if (dryRun) {
    logger.info('Dry run: skipping Langfuse dataset sync', {
      datasetName: definition.name,
      caseCount: definition.items.length
    });
    return;
  }

  try {
    await client.datasets.get(definition.name);
    logger.info('Langfuse dataset already exists', { datasetName: definition.name });
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }

    await client.datasets.create({
      name: definition.name,
      description: definition.description,
      metadata: definition.metadata,
      inputSchema: definition.inputSchema,
      expectedOutputSchema: definition.expectedOutputSchema
    });

    logger.info('Created Langfuse safety eval dataset', { datasetName: definition.name });
  }

  for (const item of definition.items) {
    await client.datasetItems.create({
      datasetName: definition.name,
      id: item.id,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata
    });
  }

  logger.info('Synced Langfuse safety eval dataset items', {
    datasetName: definition.name,
    caseCount: definition.items.length
  });
}

function initializeEvalRuntime(config: Config): void {
  configureLangfuseMetadataDefaults({
    appName: config.app.name,
    appEnv: config.app.environment,
    hostName: config.app.hostName,
    release: config.langfuse.release,
    promptVersion: process.env.PROMPT_VERSION,
    userHashSalt: config.langfuse.userHashSalt
  });

  initializeLangfuseTracing(config);

  contentSanitizer.init({
    query: async () => ({ rows: [], rowCount: 0 })
  } as never);
}

async function executeCase(testCase: SafetyEvalCase): Promise<SafetyEvalActualResult> {
  if (testCase.kind === 'input_moderation') {
    const result = await contentSanitizer.processContent(
      testCase.input.content,
      'langfuse-eval-guild',
      `langfuse-eval-${testCase.id}`,
      testCase.input.contentType,
      {
        allowMildProfanityInput: testCase.input.allowMildProfanityInput,
        useDeterministicSentimentReview: testCase.input.useDeterministicSentimentReview,
        failClosedOnError: testCase.input.failClosedOnError ?? true
      }
    );

    return {
      kind: 'input_moderation',
      allowed: result.moderation.allowed,
      action: result.moderation.action,
      responseDirective: result.moderation.responseDirective || null,
      flaggedCategories: result.moderation.flaggedCategories
    };
  }

  const decision = await evaluateCustomSystemPromptGuardrails(testCase.input.prompt, {
    failClosedOnError: testCase.input.failClosedOnError ?? true
  });

  return {
    kind: 'custom_prompt_guardrails',
    allowed: decision.allowed,
    category: decision.category || null,
    reason: decision.reason || null,
    executionFailed: decision.executionFailed || false,
    fallbackTriggered: !decision.allowed
  };
}

async function createScores(
  client: LangfuseAPIClient,
  pendingScores: PendingScore[],
  environment: string
): Promise<void> {
  for (const pending of pendingScores) {
    await client.legacy.scoreV1.create({
      traceId: pending.traceId,
      name: pending.score.name,
      value: pending.score.value,
      dataType: pending.score.dataType,
      comment: pending.score.comment,
      metadata: pending.score.metadata,
      environment
    });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = ConfigLoader.load();
  const evalCases = filterCases(args);
  const datasetName = args.datasetName || LANGFUSE_SAFETY_EVAL_DATASET_NAME;
  const evalRunId = new Date().toISOString();
  const langfuseClient = createLangfuseApiClient(config);
  const pendingScores: PendingScore[] = [];

  if (evalCases.length === 0) {
    throw new Error('No safety eval cases matched the provided filters.');
  }

  initializeEvalRuntime(config);

  if (args.syncDataset) {
    if (!langfuseClient) {
      throw new Error('Langfuse credentials are required to sync the eval dataset.');
    }

    await syncDataset(langfuseClient, config, datasetName, args.dryRun);
  }

  const summary = {
    passed: 0,
    failed: 0
  };

  for (const testCase of evalCases) {
    let traceId: string | null = null;

    const baseMetadataInput = {
      messageType: 'system-event' as const,
      commandName: 'langfuse-safety-evals'
    };

    const tags = Array.from(
      new Set([
        ...buildLangfuseTags(baseMetadataInput),
        'safety-eval',
        testCase.kind,
        ...testCase.tags
      ])
    );

    const result = await withLangfuseRootTrace(
      {
        name: 'run-safety-eval-case',
        traceName: 'eval.safety.guardrails',
        userId: 'silo-eval-runner',
        sessionId: `silo-safety-evals:${evalRunId}`,
        metadata: {
          ...buildLangfuseTraceMetadata(baseMetadataInput),
          evalRunId,
          evalCaseId: testCase.id,
          evalCaseKind: testCase.kind,
          evalTags: testCase.tags,
          evalDatasetName: datasetName,
          evalExpected: testCase.expected
        },
        tags
      },
      async (observation, rootTraceId) => {
        traceId = rootTraceId;
        const actual = await executeCase(testCase);
        const comparison = compareSafetyEvalResult(testCase, actual);

        observation?.update({
          output: {
            passed: comparison.passed,
            summary: comparison.summary,
            actual
          },
          metadata: {
            comparison: comparison.scoreBreakdown
          },
          level: comparison.passed ? 'DEFAULT' : 'WARNING'
        });

        return { actual, comparison };
      }
    );

    if (result.comparison.passed) {
      summary.passed += 1;
    } else {
      summary.failed += 1;
    }

    logger.info('Completed safety eval case', {
      caseId: testCase.id,
      passed: result.comparison.passed,
      summary: result.comparison.summary
    });

    if (!args.noScores && traceId) {
      for (const score of buildLangfuseSafetyScoreRequests(testCase, result.comparison)) {
        pendingScores.push({
          traceId,
          score: {
            ...score,
            metadata: {
              ...score.metadata,
              evalRunId,
              evalDatasetName: datasetName
            }
          }
        });
      }
    }
  }

  await shutdownLangfuseTracing();

  if (!args.noScores && pendingScores.length > 0) {
    if (!langfuseClient) {
      logger.warn('Skipping Langfuse score writes because credentials are not configured.', {
        pendingScoreCount: pendingScores.length
      });
    } else if (args.dryRun) {
      logger.info('Dry run: skipping Langfuse score writes', {
        pendingScoreCount: pendingScores.length
      });
    } else {
      await createScores(langfuseClient, pendingScores, config.langfuse.environment);
      logger.info('Created Langfuse safety eval scores', {
        scoreCount: pendingScores.length
      });
    }
  }

  logger.info('Safety eval run complete', {
    evalRunId,
    caseCount: evalCases.length,
    passed: summary.passed,
    failed: summary.failed,
    datasetName,
    dryRun: args.dryRun
  });

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch(async error => {
  await shutdownLangfuseTracing();
  logger.error('Langfuse safety eval scaffold failed', error);
  process.exitCode = 1;
});
