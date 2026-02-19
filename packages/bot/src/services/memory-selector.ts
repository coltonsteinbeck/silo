import { type Config, type DatabaseAdapter, type ServerMemory, logger } from '@silo/core';
import type { ProviderRegistry } from '../providers/registry';

type CandidateScore = {
  memory: ServerMemory;
  keywordScore: number;
  semanticScore: number;
  entityScore: number;
  cueScore: number;
  totalScore: number;
};

export type MemorySelectionResult = {
  context: string;
  selected: ServerMemory[];
  shouldMention: boolean;
  mentionConfidence: number;
  usedFallback: boolean;
};

const CUE_PATTERNS = [
  /\blore\b/i,
  /\bremember\b/i,
  /\blast\s+time\b/i,
  /\bcall\s+back\b/i,
  /\bcallback\b/i,
  /\byou\s+said\b/i,
  /\bwe\s+talked\s+about\b/i,
  /\bpreviously\b/i,
  /\bbefore\b/i
];

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'with',
  'this',
  'from',
  'have',
  'what',
  'about',
  'your',
  'just',
  'into',
  'there',
  'they',
  'them',
  'were',
  'when',
  'where',
  'would',
  'could',
  'should',
  'like',
  'then',
  'than',
  'been',
  'over',
  'make',
  'more',
  'less',
  'very',
  'really'
]);

function normalizeTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 3 && !STOPWORDS.has(token));
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function extractEntities(memory: ServerMemory): string[] {
  const metadataEntities = Array.isArray(memory.metadata?.entities)
    ? memory.metadata?.entities.filter((item): item is string => typeof item === 'string')
    : [];

  if (metadataEntities.length > 0) {
    return unique(metadataEntities.map(entity => entity.toLowerCase().trim()).filter(Boolean));
  }

  const source = `${memory.title || ''} ${memory.memoryContent}`;
  const matches = source.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g) || [];
  return unique(matches.map(entity => entity.toLowerCase()));
}

function buildMemoryContext(memories: ServerMemory[]): string {
  if (memories.length === 0) {
    return '';
  }

  let context = '\n\n**Relevant Memory Context (use only if helpful):**\n';
  for (const memory of memories) {
    context += `- [${memory.contextType}] ${memory.memoryContent}\n`;
  }

  return context;
}

async function loadSemanticCandidates(
  db: DatabaseAdapter,
  registry: ProviderRegistry,
  serverId: string,
  query: string,
  limit: number
): Promise<(ServerMemory & { similarity: number })[]> {
  try {
    if (!registry.hasEmbeddingProvider()) {
      return [];
    }

    const embeddingProvider = registry.getEmbeddingProvider();
    const vectors = await embeddingProvider.generateEmbeddings([query]);
    const queryEmbedding = vectors[0];

    if (!queryEmbedding) {
      return [];
    }

    return await db.searchServerMemoriesByEmbedding(serverId, queryEmbedding, undefined, limit);
  } catch (error) {
    logger.warn('Semantic memory retrieval unavailable, continuing with lexical matching', error);
    return [];
  }
}

export async function selectMemoryContext(params: {
  db: DatabaseAdapter;
  registry: ProviderRegistry;
  config: Config;
  serverId: string;
  content: string;
}): Promise<MemorySelectionResult> {
  const { db, registry, config, serverId, content } = params;
  const memoryConfig = config.memory;

  const retrievalLimit = memoryConfig.retrievalLimit;
  const candidateLimit = Math.max(retrievalLimit * 3, retrievalLimit + 2);
  const queryTokens = unique(normalizeTokens(content));
  const queryTokenSet = new Set(queryTokens);
  const hasCue = CUE_PATTERNS.some(pattern => pattern.test(content));

  const [semanticCandidates, lexicalCandidates] = await Promise.all([
    loadSemanticCandidates(db, registry, serverId, content, candidateLimit),
    db.searchServerMemories(serverId, content, candidateLimit)
  ]);

  const semanticMap = new Map<string, number>();
  for (const item of semanticCandidates) {
    semanticMap.set(item.id, clamp01(item.similarity));
  }

  const candidateMap = new Map<string, ServerMemory>();
  for (const memory of lexicalCandidates) {
    candidateMap.set(memory.id, memory);
  }
  for (const memory of semanticCandidates) {
    candidateMap.set(memory.id, memory);
  }

  if (candidateMap.size === 0 && hasCue) {
    const recent = await db.getServerMemories(serverId, undefined, candidateLimit);
    for (const memory of recent) {
      candidateMap.set(memory.id, memory);
    }
  }

  const scored: CandidateScore[] = [];
  for (const memory of candidateMap.values()) {
    const memoryTokens = unique(normalizeTokens(memory.memoryContent));
    const overlapCount = memoryTokens.reduce(
      (count, token) => (queryTokenSet.has(token) ? count + 1 : count),
      0
    );

    const keywordDenominator = Math.max(1, Math.min(queryTokenSet.size, 8));
    const keywordScore = clamp01(overlapCount / keywordDenominator);

    const semanticScore = semanticMap.get(memory.id) ?? 0;
    const entityMatches = extractEntities(memory).filter(entity =>
      content.toLowerCase().includes(entity)
    );
    const entityScore = clamp01(
      entityMatches.length > 0 ? Math.min(entityMatches.length / 3, 1) : 0
    );
    const cueScore = hasCue ? 1 : 0;

    const totalScore = clamp01(
      keywordScore * memoryConfig.keywordWeight +
        semanticScore * memoryConfig.semanticWeight +
        cueScore * memoryConfig.cueWeight +
        entityScore * memoryConfig.entityWeight
    );

    scored.push({
      memory,
      keywordScore,
      semanticScore,
      entityScore,
      cueScore,
      totalScore
    });
  }

  scored.sort(
    (a, b) =>
      b.totalScore - a.totalScore || b.memory.createdAt.getTime() - a.memory.createdAt.getTime()
  );

  const strongMatches = scored.filter(
    candidate =>
      candidate.totalScore >= memoryConfig.triggerThreshold ||
      candidate.semanticScore >= memoryConfig.semanticMinSimilarity
  );

  if (strongMatches.length > 0) {
    const selected = strongMatches.slice(0, retrievalLimit).map(item => item.memory);
    const top = strongMatches[0]!;

    return {
      context: buildMemoryContext(selected),
      selected,
      shouldMention: top.keywordScore >= memoryConfig.keywordMentionThreshold,
      mentionConfidence: top.keywordScore,
      usedFallback: false
    };
  }

  const fallbackSelectedFromScores = scored
    .slice(0, memoryConfig.fallbackLimit)
    .map(item => item.memory);
  if (fallbackSelectedFromScores.length > 0) {
    return {
      context: buildMemoryContext(fallbackSelectedFromScores),
      selected: fallbackSelectedFromScores,
      shouldMention: false,
      mentionConfidence: 0,
      usedFallback: true
    };
  }

  const latestFallback = await db.getServerMemories(
    serverId,
    undefined,
    memoryConfig.fallbackLimit
  );
  return {
    context: buildMemoryContext(latestFallback),
    selected: latestFallback,
    shouldMention: false,
    mentionConfidence: 0,
    usedFallback: latestFallback.length > 0
  };
}
