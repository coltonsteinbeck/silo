import { describe, expect, test } from 'bun:test';
import {
  buildLangfuseTraceMetadata,
  configureLangfuseMetadataDefaults
} from '../../telemetry/langfuse-metadata';

describe('Langfuse metadata', () => {
  test('includes bounded graph metadata fields', () => {
    const metadata = buildLangfuseTraceMetadata({
      guildId: 'guild-1',
      messageType: 'discord-message',
      provider: 'openai',
      model: 'gpt-test',
      graphName: 'discord-message-agent',
      graphVersion: 'v1',
      graphNode: 'tool_planning',
      graphStep: 4,
      graphRecursionLimit: 12,
      questionType: 'mixed',
      questionCount: 2,
      searchableQuestionCount: 1,
      conversationalQuestionCount: 1,
      toolBudget: {
        maxToolCalls: 3,
        maxWebSearches: 1
      },
      toolsAllowed: ['image_generation', 'web_search'],
      toolsCalled: ['web_search'],
      safetyState: 'allowed',
      graphOutcome: 'success'
    });

    expect(metadata.graphName).toBe('discord-message-agent');
    expect(metadata.graphVersion).toBe('v1');
    expect(metadata.graphNode).toBe('tool_planning');
    expect(metadata.graphStep).toBe(4);
    expect(metadata.graphRecursionLimit).toBe(12);
    expect(metadata.questionType).toBe('mixed');
    expect(metadata.questionCount).toBe(2);
    expect(metadata.searchableQuestionCount).toBe(1);
    expect(metadata.conversationalQuestionCount).toBe(1);
    expect(metadata.toolBudget).toEqual({
      maxToolCalls: 3,
      maxWebSearches: 1
    });
    expect(metadata.toolsAllowed).toEqual(['image_generation', 'web_search']);
    expect(metadata.toolsCalled).toEqual(['web_search']);
    expect(metadata.safetyState).toBe('allowed');
    expect(metadata.graphOutcome).toBe('success');
  });

  test('includes scoped context and recovery metadata', () => {
    const metadata = buildLangfuseTraceMetadata({
      promptVersion: 'jimbepo-v2',
      promptHash: 'prompt-hash',
      contextScope: 'same_user',
      contextSelectedTurnCount: 2,
      contextExcludedTurnCount: 3,
      contextExclusionReasons: ['legacy', 'unsafe', 'unpaired'],
      inputContextEligible: false,
      modelCircuitFailureCount: 3,
      modelCircuitActivated: true,
      modelCircuitContextDisabled: true,
      modelCircuitContextDisabledUntil: '2026-07-09T18:00:00.000Z',
      temperature: 0.2,
      recoveryAttempt: 1,
      recoveryContextFree: true
    });

    expect(metadata).toMatchObject({
      promptVersion: 'jimbepo-v2',
      promptHash: 'prompt-hash',
      contextScope: 'same_user',
      contextSelectedTurnCount: 2,
      contextExcludedTurnCount: 3,
      contextExclusionReasons: ['legacy', 'unsafe', 'unpaired'],
      inputContextEligible: false,
      modelCircuitFailureCount: 3,
      modelCircuitActivated: true,
      modelCircuitContextDisabled: true,
      modelCircuitContextDisabledUntil: '2026-07-09T18:00:00.000Z',
      temperature: 0.2,
      recoveryAttempt: 1,
      recoveryContextFree: true
    });
  });

  test('resolves the release commit from explicit metadata and CI environment fallbacks', () => {
    const originalReleaseCommit = process.env.RELEASE_COMMIT;
    const originalGithubSha = process.env.GITHUB_SHA;

    try {
      process.env.RELEASE_COMMIT = 'release-commit-sha';
      process.env.GITHUB_SHA = 'github-fallback-sha';

      expect(buildLangfuseTraceMetadata({}).releaseCommit).toBe('release-commit-sha');
      expect(
        buildLangfuseTraceMetadata({ releaseCommit: 'explicit-config-sha' }).releaseCommit
      ).toBe('explicit-config-sha');

      delete process.env.RELEASE_COMMIT;
      expect(buildLangfuseTraceMetadata({}).releaseCommit).toBe('github-fallback-sha');
    } finally {
      if (originalReleaseCommit === undefined) {
        delete process.env.RELEASE_COMMIT;
      } else {
        process.env.RELEASE_COMMIT = originalReleaseCommit;
      }
      if (originalGithubSha === undefined) {
        delete process.env.GITHUB_SHA;
      } else {
        process.env.GITHUB_SHA = originalGithubSha;
      }
    }
  });

  test('uses a configured release commit default before environment fallbacks', () => {
    const originalReleaseCommit = process.env.RELEASE_COMMIT;

    try {
      process.env.RELEASE_COMMIT = 'environment-sha';
      configureLangfuseMetadataDefaults({ releaseCommit: 'configured-default-sha' });

      expect(buildLangfuseTraceMetadata({}).releaseCommit).toBe('configured-default-sha');
      expect(buildLangfuseTraceMetadata({ releaseCommit: 'per-trace-sha' }).releaseCommit).toBe(
        'per-trace-sha'
      );
    } finally {
      if (originalReleaseCommit === undefined) {
        delete process.env.RELEASE_COMMIT;
      } else {
        process.env.RELEASE_COMMIT = originalReleaseCommit;
      }
    }
  });
});
