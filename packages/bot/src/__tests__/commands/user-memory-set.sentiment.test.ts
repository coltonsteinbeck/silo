import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockDatabaseAdapter, createMockInteraction } from '@silo/core/test-setup';
import type { SentimentClassification } from '../../security/sentiment-classifier';
import { sentimentClassifier } from '../../security/sentiment-classifier';
import { UserMemorySetCommand } from '../../commands/memory/user-set';

describe('UserMemorySetCommand sentiment metadata', () => {
  let mockDb: any;
  let command: UserMemorySetCommand;
  let originalClassifyPrompt: typeof sentimentClassifier.classifyPrompt;

  beforeEach(() => {
    mockDb = createMockDatabaseAdapter();
    mockDb.storeUserMemory = mock(async (opts: any) => ({
      id: 'new-memory-id',
      ...opts,
      createdAt: new Date()
    }));

    command = new UserMemorySetCommand(mockDb);
    originalClassifyPrompt = sentimentClassifier.classifyPrompt;
  });

  afterEach(() => {
    sentimentClassifier.classifyPrompt = originalClassifyPrompt;
  });

  test('stores sentiment metadata when sentiment confidence passes apply threshold', async () => {
    const classification: SentimentClassification = {
      label: 'negative',
      score: -0.7,
      confidence: 0.9,
      urgency: 0.6,
      frustration: 0.8,
      confusion: 0.4,
      source: 'heuristic'
    };

    sentimentClassifier.classifyPrompt = mock(async () => classification);

    const interaction = createMockInteraction({
      options: {
        content: 'I am frustrated with this setup',
        type: 'mood'
      }
    });

    await command.execute(interaction as any);

    const payload = mockDb.storeUserMemory.mock.calls[0]?.[0];
    expect(payload.metadata).toMatchObject({
      sentimentLabel: 'negative',
      sentimentScore: -0.7,
      sentimentConfidence: 0.9,
      toneFlags: {
        urgency: 0.6,
        frustration: 0.8,
        confusion: 0.4
      }
    });
  });

  test('does not store sentiment metadata when classifyPrompt returns null', async () => {
    sentimentClassifier.classifyPrompt = mock(async () => null);

    const interaction = createMockInteraction({
      options: {
        content: 'Store this preference',
        type: 'preference'
      }
    });

    await command.execute(interaction as any);

    const payload = mockDb.storeUserMemory.mock.calls[0]?.[0];
    expect(payload.metadata.sentimentLabel).toBeUndefined();
    expect(payload.metadata.sentimentScore).toBeUndefined();
    expect(payload.metadata.sentimentConfidence).toBeUndefined();
    expect(payload.metadata.toneFlags).toBeUndefined();
  });

  test('does not store sentiment metadata when confidence is below apply threshold', async () => {
    const lowConfidenceClassification: SentimentClassification = {
      label: 'positive',
      score: 0.6,
      confidence: 0.1,
      urgency: 0.2,
      frustration: 0.1,
      confusion: 0.1,
      source: 'ai'
    };

    sentimentClassifier.classifyPrompt = mock(async () => lowConfidenceClassification);

    const interaction = createMockInteraction({
      options: {
        content: 'Store this summary',
        type: 'summary'
      }
    });

    await command.execute(interaction as any);

    const payload = mockDb.storeUserMemory.mock.calls[0]?.[0];
    expect(payload.metadata.sentimentLabel).toBeUndefined();
    expect(payload.metadata.sentimentScore).toBeUndefined();
    expect(payload.metadata.sentimentConfidence).toBeUndefined();
    expect(payload.metadata.toneFlags).toBeUndefined();
  });
});
