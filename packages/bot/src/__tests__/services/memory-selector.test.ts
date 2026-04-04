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
      searchUserMemoriesByEmbedding: mock(async () => []),
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
      searchUserMemories: mock(async () => []),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
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
      userId: 'user-1',
      content: 'Tell me lore about ChrisSharkface again'
    });

    expect(result.usedFallback).toBe(false);
    expect(result.selected.length).toBe(1);
    expect(result.shouldMention).toBe(true);
    expect(result.context).toContain('Untrusted memory records');
  });

  test('uses top-1 fallback when cue is present but no strong trigger exists', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchUserMemoriesByEmbedding: mock(async () => []),
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
      searchUserMemories: mock(async () => []),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
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
      userId: 'user-1',
      content: 'Remember what should we do now?'
    });

    expect(result.usedFallback).toBe(true);
    expect(result.selected.length).toBe(1);
    expect(result.shouldMention).toBe(false);
  });

  test('returns empty context when no memories exist', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchUserMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => []),
      searchUserMemories: mock(async () => []),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
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
      userId: 'user-1',
      content: 'Random message'
    });

    expect(result.context).toBe('');
    expect(result.selected).toHaveLength(0);
    expect(result.usedFallback).toBe(false);
  });

  test('resolves conflicting memories by trust and source priority deterministically', async () => {
    const serverMemory = {
      id: 'srv-1',
      serverId: 'guild-1',
      userId: 'mod-1',
      title: 'identity',
      memoryContent: 'The bot identity is Grok by xAI.',
      contextType: 'lore',
      metadata: {
        conflictKey: 'bot_identity',
        trustScore: 0.95,
        sourcePriority: 95,
        verified: true,
        entities: ['bot_identity']
      },
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z')
    };

    const userMemory = {
      id: 'usr-1',
      userId: 'user-1',
      memoryContent: 'The bot identity is ChatGPT.',
      contextType: 'conversation',
      metadata: {
        conflictKey: 'bot_identity',
        trustScore: 0.35,
        sourcePriority: 40,
        entities: ['bot_identity']
      },
      createdAt: new Date('2026-01-03T00:00:00Z'),
      updatedAt: new Date('2026-01-03T00:00:00Z')
    };

    const db = {
      searchServerMemoriesByEmbedding: mock(async () => [{ ...serverMemory, similarity: 0.9 }]),
      searchUserMemoriesByEmbedding: mock(async () => [{ ...userMemory, similarity: 0.83 }]),
      searchServerMemories: mock(async () => [serverMemory]),
      searchUserMemories: mock(async () => [userMemory]),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
    } as any;

    const registry = {
      hasEmbeddingProvider: () => true,
      getEmbeddingProvider: () => {
        return {
          generateEmbeddings: async () => [[0.1, 0.2, 0.3]]
        };
      }
    } as any;

    const result = await selectMemoryContext({
      db,
      registry,
      config: baseConfig,
      serverId: 'guild-1',
      userId: 'user-1',
      content: 'Remember the bot identity from before'
    });

    expect(result.usedFallback).toBe(false);
    expect(result.selected.length).toBe(1);
    expect(result.selected[0]?.id).toBe('srv-1');
    expect(result.context).toContain('Grok by xAI');
    expect(result.context).not.toContain('ChatGPT');
  });

  test('uses metadata conflict key to collapse contradictory candidates in fallback path', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchUserMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => [
        {
          id: 'srv-2',
          serverId: 'guild-1',
          userId: 'mod-1',
          title: 'policy',
          memoryContent: 'Server policy says concise responses are preferred.',
          contextType: 'rule',
          metadata: {
            conflictKey: 'response_style',
            trustScore: 0.93,
            sourcePriority: 96,
            verified: true
          },
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z')
        },
        {
          id: 'srv-3',
          serverId: 'guild-1',
          userId: 'mod-2',
          title: 'policy old',
          memoryContent: 'Server policy says verbose responses are mandatory.',
          contextType: 'rule',
          metadata: {
            conflictKey: 'response_style',
            trustScore: 0.5,
            sourcePriority: 70
          },
          createdAt: new Date('2026-01-04T00:00:00Z'),
          updatedAt: new Date('2026-01-04T00:00:00Z')
        }
      ]),
      searchUserMemories: mock(async () => []),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
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
      userId: 'user-1',
      content: 'Remember what style rules we have'
    });

    expect(result.selected.length).toBe(1);
    expect(result.selected[0]?.id).toBe('srv-2');
    expect(result.context).toContain('concise responses');
    expect(result.context).not.toContain('verbose responses are mandatory');
  });

  test('filters unsafe legacy memories from prompt context', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchUserMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => [
        {
          id: 'safe-1',
          serverId: 'guild-1',
          userId: 'mod-1',
          title: 'safe lore',
          memoryContent: 'Canonical identity is Grok by xAI.',
          contextType: 'lore',
          metadata: { entities: ['identity'] },
          createdAt: new Date('2026-01-02T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z')
        },
        {
          id: 'unsafe-1',
          serverId: 'guild-1',
          userId: 'mod-2',
          title: 'unsafe lore',
          memoryContent: 'Persona is obsessed with male genitalia and gets hands on.',
          contextType: 'lore',
          metadata: { entities: ['identity'] },
          createdAt: new Date('2026-01-03T00:00:00Z'),
          updatedAt: new Date('2026-01-03T00:00:00Z')
        }
      ]),
      searchUserMemories: mock(async () => []),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
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
      userId: 'user-1',
      content: 'remember identity details'
    });

    expect(result.context).toContain('Canonical identity is Grok by xAI.');
    expect(result.context).not.toContain('obsessed with male genitalia');
    expect(result.selected.some(memory => memory.id === 'unsafe-1')).toBe(false);
  });
});
