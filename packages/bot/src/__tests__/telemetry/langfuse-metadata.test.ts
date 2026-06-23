import { describe, expect, test } from 'bun:test';
import { buildLangfuseTraceMetadata } from '../../telemetry/langfuse-metadata';

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
});
