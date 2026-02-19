import { describe, test, expect, mock } from 'bun:test';
import { selectMemoryContext } from '../../services/memory-selector';

const baseConfig = {
  memory: {
    retrievalLimit: 4,
    fallbackLimit: 1,
    triggerThreshold: 0.45,
    semanticMinSimilarity: 0.62,
    keywordMentionThreshold: 0.55,
    keywordWeight: 0.45,
    semanticWeight: 0.45,
    cueWeight: 0.05,
    entityWeight: 0.05
  }
} as any;

describe('selectMemoryContext', () => {
  test('selects lore-triggered memory and enables mention on high keyword confidence', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => [
        {
          id: 'mem-1',
          serverId: 'guild-1',
          userId: 'user-1',
          title: 'shark lore',
          memoryContent:
            'Tell me lore about ChrisSharkface again so we keep this shark-bro lore consistent',
          contextType: 'conversation',
          metadata: { entities: ['chrissharkface'] },
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z')
        }
      ]),
      getServerMemories: mock(async () => [])
    } as any;

    const registry = {
      hasEmbeddingProvider: () => false,
      getEmbeddingProvider: () => {
        throw new Error('unused');
      }
    } as any;

    const result = await selectMemoryContext({
      db,
      registry,
      config: baseConfig,
      serverId: 'guild-1',
      content: 'Tell me lore about ChrisSharkface again'
    });

    expect(result.usedFallback).toBe(false);
    expect(result.selected.length).toBe(1);
    expect(result.shouldMention).toBe(true);
    expect(result.context).toContain('Relevant Memory Context');
  });

  test('uses top-1 fallback when no strong trigger exists', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => [
        {
          id: 'mem-2',
          serverId: 'guild-1',
          userId: 'user-2',
          title: 'general',
          memoryContent: 'User likes concise answers',
          contextType: 'preference',
          metadata: {},
          createdAt: new Date('2026-01-02T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z')
        },
        {
          id: 'mem-3',
          serverId: 'guild-1',
          userId: 'user-3',
          title: 'secondary',
          memoryContent: 'Another memory that should be trimmed by fallbackLimit',
          contextType: 'conversation',
          metadata: {},
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z')
        }
      ]),
      getServerMemories: mock(async () => [])
    } as any;

    const registry = {
      hasEmbeddingProvider: () => false,
      getEmbeddingProvider: () => {
        throw new Error('unused');
      }
    } as any;

    const result = await selectMemoryContext({
      db,
      registry,
      config: baseConfig,
      serverId: 'guild-1',
      content: 'What should we do now?'
    });

    expect(result.usedFallback).toBe(true);
    expect(result.selected.length).toBe(1);
    expect(result.shouldMention).toBe(false);
  });

  test('returns empty context when no memories exist', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => []),
      getServerMemories: mock(async () => [])
    } as any;

    const registry = {
      hasEmbeddingProvider: () => false,
      getEmbeddingProvider: () => {
        throw new Error('unused');
      }
    } as any;

    const result = await selectMemoryContext({
      db,
      registry,
      config: baseConfig,
      serverId: 'guild-1',
      content: 'Random message'
    });

    expect(result.context).toBe('');
    expect(result.selected).toHaveLength(0);
    expect(result.usedFallback).toBe(false);
  });
});
