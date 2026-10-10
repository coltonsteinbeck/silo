import { describe, test, expect, mock } from 'bun:test';
import {
  isLoreMemoryExplicitlyReferenced,
  selectMemoryContext
} from '../../services/memory-selector';

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
  test('requires the latest user message to explicitly reference selected lore', () => {
    const lore = {
      memoryContent: 'The third egg belongs to the screaming worm council.',
      contextType: 'lore',
      metadata: { entities: ['worm council'] },
      title: 'worm council'
    };

    expect(isLoreMemoryExplicitlyReferenced('Talk to me', lore)).toBe(false);
    expect(isLoreMemoryExplicitlyReferenced('What was the third egg?', lore)).toBe(true);
    expect(isLoreMemoryExplicitlyReferenced('Tell me about the worm council', lore)).toBe(true);
  });

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

  test('enables natural mention for strong semantic match on user memory', async () => {
    const userMemory = {
      id: 'usr-sem-1',
      userId: 'user-1',
      memoryContent: 'User prefers concise bullet points and direct summaries.',
      contextType: 'preference',
      metadata: { entities: ['formatting'] },
      createdAt: new Date('2026-01-05T00:00:00Z'),
      updatedAt: new Date('2026-01-05T00:00:00Z')
    };

    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchUserMemoriesByEmbedding: mock(async () => [{ ...userMemory, similarity: 0.76 }]),
      searchServerMemories: mock(async () => []),
      searchUserMemories: mock(async () => [userMemory]),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
    } as any;

    const registry = {
      hasEmbeddingProvider: () => true,
      getEmbeddingProvider: () => ({
        generateEmbeddings: async () => [[0.1, 0.2, 0.3]]
      })
    } as any;

    const result = await selectMemoryContext({
      db,
      registry,
      config: baseConfig,
      serverId: 'guild-1',
      userId: 'user-1',
      content: 'Can you keep your responses tighter and more direct for me today?'
    });

    expect(result.usedFallback).toBe(false);
    expect(result.selected[0]?.id).toBe('usr-sem-1');
    expect(result.shouldMention).toBe(true);
    expect(result.mentionConfidence).toBeGreaterThan(0.55);
  });

  test('allows mention on adjacent cue+entity fallback matches without forcing every memory mention', async () => {
    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchUserMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => [
        {
          id: 'srv-adj-1',
          serverId: 'guild-1',
          userId: 'mod-1',
          title: 'agent lore',
          memoryContent: 'Agent oe285228 is a spy handling covert logistics.',
          contextType: 'lore',
          metadata: { entities: ['oe285228', 'spy'] },
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
      content: 'Remember oe285228 spy details for this thread'
    });

    expect(result.usedFallback).toBe(true);
    expect(result.selected.length).toBe(1);
    expect(result.shouldMention).toBe(true);
    expect(result.mentionConfidence).toBeGreaterThan(0.5);
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

  test('uses low-weight sentiment coherence to break near ties', async () => {
    const memoryPositive = {
      id: 'mood-pos-1',
      userId: 'user-1',
      memoryContent: 'User prefers upbeat guidance with momentum.',
      contextType: 'mood',
      metadata: {
        trustScore: 0.7,
        sourcePriority: 56,
        sentimentScore: 0.7
      },
      createdAt: new Date('2026-01-05T00:00:00Z'),
      updatedAt: new Date('2026-01-05T00:00:00Z')
    };

    const memoryNegative = {
      id: 'mood-neg-1',
      userId: 'user-1',
      memoryContent: 'User prefers calm de-escalation when stressed.',
      contextType: 'mood',
      metadata: {
        trustScore: 0.7,
        sourcePriority: 56,
        sentimentScore: -0.7
      },
      createdAt: new Date('2026-01-05T00:00:00Z'),
      updatedAt: new Date('2026-01-05T00:00:00Z')
    };

    const db = {
      searchServerMemoriesByEmbedding: mock(async () => []),
      searchUserMemoriesByEmbedding: mock(async () => []),
      searchServerMemories: mock(async () => []),
      searchUserMemories: mock(async () => [memoryPositive, memoryNegative]),
      getServerMemories: mock(async () => []),
      getUserMemories: mock(async () => [])
    } as any;

    const registry = {
      hasEmbeddingProvider: () => false,
      getEmbeddingProvider: () => {
        throw new Error('unused');
      }
    } as any;

    const positiveResult = await selectMemoryContext({
      db,
      registry,
      config: baseConfig,
      serverId: 'guild-1',
      userId: 'user-1',
      content: 'Remember my preferred support tone',
      sentimentScore: 0.8
    });

    const negativeResult = await selectMemoryContext({
      db,
      registry,
      config: baseConfig,
      serverId: 'guild-1',
      userId: 'user-1',
      content: 'Remember my preferred support tone',
      sentimentScore: -0.8
    });

    expect(positiveResult.selected[0]?.id).toBe('mood-pos-1');
    expect(negativeResult.selected[0]?.id).toBe('mood-neg-1');
  });
});
