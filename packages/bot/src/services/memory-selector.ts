import {
  type Config,
  type DatabaseAdapter,
  type ServerMemory,
  type UserMemory,
  logger
} from '@silo/core';
import type { ProviderRegistry } from '../providers/registry';

type MemoryType = ServerMemory | UserMemory;

type CandidateScore = {
  memory: MemoryType;
  keywordScore: number;
  semanticScore: number;
  entityScore: number;
  cueScore: number;
  totalScore: number;
};

export type MemorySelectionResult = {
  context: string;
  selected: MemoryType[];
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
  /\bbefore\b/i,
  /\bwho\s+are\s+you\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\bare\s+you\s+(?:a|an|the)?\s*\w+\b/i,
  /\byour\s+(?:role|identity|backstory)\b/i
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

function getMemoryScope(memory: MemoryType): 'server' | 'user' {
  return 'serverId' in memory ? 'server' : 'user';
}

function summarizeMemory(memory: MemoryType): string {
  return `${getMemoryScope(memory)}:${memory.id.slice(0, 8)}:${memory.contextType}`;
}

function summarizeCandidate(candidate: CandidateScore): string {
  return `${summarizeMemory(candidate.memory)}(total=${candidate.totalScore.toFixed(2)},kw=${candidate.keywordScore.toFixed(2)},sem=${candidate.semanticScore.toFixed(2)},ent=${candidate.entityScore.toFixed(2)})`;
}

function isLoreOrPersona(memory: MemoryType): boolean {
  const memoryType = memory.contextType.toLowerCase();
  return memoryType === 'lore' || memoryType === 'persona';
}

function extractEntities(memory: MemoryType): string[] {
  const metadataEntities = Array.isArray(memory.metadata?.entities)
    ? memory.metadata?.entities.filter((item): item is string => typeof item === 'string')
    : [];

  if (metadataEntities.length > 0) {
    return unique(metadataEntities.map(entity => entity.toLowerCase().trim()).filter(Boolean));
  }

  const title = 'title' in memory ? memory.title || '' : '';
  const source = `${title} ${memory.memoryContent}`;
  const matches = source.match(/\b[A-Z][A-Za-z0-9_-]{2,}\b/g) || [];
  return unique(matches.map(entity => entity.toLowerCase()));
}

function buildMemoryContext(memories: MemoryType[]): string {
  if (memories.length === 0) {
    return '';
  }

  let context = '\n\n**Relevant Memory Context (use only if helpful):**\n';
  for (const memory of memories) {
    context += `- [${memory.contextType}] (User ${memory.userId}): ${memory.memoryContent}\n`;
  }

  return context;
}

async function loadSemanticCandidates(
  db: DatabaseAdapter,
  registry: ProviderRegistry,
  serverId: string,
  userId: string,
  query: string,
  limit: number
): Promise<(MemoryType & { similarity: number })[]> {
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

    const [serverMemories, userMemories] = await Promise.all([
      db.searchServerMemoriesByEmbedding(serverId, queryEmbedding, undefined, limit),
      db.searchUserMemoriesByEmbedding(userId, queryEmbedding, undefined, limit)
    ]);

    return [...serverMemories, ...userMemories];
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
  userId: string;
  content: string;
}): Promise<MemorySelectionResult> {
  const { db, registry, config, serverId, userId, content } = params;
  const memoryConfig = config.memory;

  const retrievalLimit = memoryConfig.retrievalLimit;
  const candidateLimit = Math.max(retrievalLimit * 3, retrievalLimit + 2);
  const queryTokens = unique(normalizeTokens(content));
  const queryTokenSet = new Set(queryTokens);
  const hasCue = CUE_PATTERNS.some(pattern => pattern.test(content));
  const isIdentityQuery =
    /\bwho\s+are\s+you\b/i.test(content) ||
    /\bwhat\s+are\s+you\b/i.test(content) ||
    /\bare\s+you\s+(?:a|an|the)?\s*\w+\b/i.test(content);
  const allowFallback = hasCue || isIdentityQuery;

  const [semanticCandidates, serverLexicalCandidates, userLexicalCandidates] = await Promise.all([
    loadSemanticCandidates(db, registry, serverId, userId, content, candidateLimit),
    db.searchServerMemories(serverId, content, candidateLimit),
    db.searchUserMemories(userId, content, candidateLimit)
  ]);

  const semanticServerCount = semanticCandidates.filter(item => 'serverId' in item).length;
  const semanticUserCount = semanticCandidates.length - semanticServerCount;
  logger.info(
    `Memory retrieval: user=${userId}, serverLexical=${serverLexicalCandidates.length}, userLexical=${userLexicalCandidates.length}, serverSemantic=${semanticServerCount}, userSemantic=${semanticUserCount}, hasCue=${hasCue}, identityQuery=${isIdentityQuery}`
  );

  const lexicalCandidates = [...serverLexicalCandidates, ...userLexicalCandidates];

  const semanticMap = new Map<string, number>();
  for (const item of semanticCandidates) {
    semanticMap.set(item.id, clamp01(item.similarity));
  }

  const candidateMap = new Map<string, MemoryType>();
  for (const memory of lexicalCandidates) {
    candidateMap.set(memory.id, memory);
  }
  for (const memory of semanticCandidates) {
    candidateMap.set(memory.id, memory);
  }

  if (candidateMap.size === 0 && allowFallback) {
    const [recentServer, recentUser] = await Promise.all([
      db.getServerMemories(serverId, undefined, candidateLimit),
      db.getUserMemories(userId, undefined, candidateLimit)
    ]);
    for (const memory of [...recentServer, ...recentUser]) {
      candidateMap.set(memory.id, memory);
    }
    logger.info(
      `Memory cue fallback pool: user=${userId}, recentServer=${recentServer.length}, recentUser=${recentUser.length}`
    );
  }

  const scored: CandidateScore[] = [];
  for (const memory of candidateMap.values()) {
    if (isIdentityQuery) {
      if (getMemoryScope(memory) !== 'server') {
        continue;
      }
      if (!isLoreOrPersona(memory)) {
        continue;
      }
    }

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
      candidate.semanticScore >= memoryConfig.semanticMinSimilarity ||
      (candidate.totalScore >= memoryConfig.triggerThreshold &&
        (candidate.semanticScore > 0 || hasCue))
  );

  if (scored.length > 0) {
    const topScored = scored
      .slice(0, Math.min(3, scored.length))
      .map(summarizeCandidate)
      .join(', ');
    logger.debug(`Memory scoring top candidates for user=${userId}: ${topScored}`);
  }

  if (strongMatches.length > 0) {
    const selected = strongMatches.slice(0, retrievalLimit).map(item => item.memory);
    const top = strongMatches[0]!;
    const selectedHasLore = selected.some(memory => memory.contextType === 'lore');
    logger.info(
      `Memory strong match selected for user=${userId}: ${selected.map(summarizeMemory).join(', ')}`
    );

    return {
      context: buildMemoryContext(selected),
      selected,
      shouldMention:
        top.keywordScore >= memoryConfig.keywordMentionThreshold ||
        (isIdentityQuery && selectedHasLore),
      mentionConfidence: top.keywordScore,
      usedFallback: false
    };
  }

  const fallbackSelectedFromScores = allowFallback
    ? scored.slice(0, memoryConfig.fallbackLimit).map(item => item.memory)
    : [];
  if (fallbackSelectedFromScores.length > 0) {
    const fallbackHasLore = fallbackSelectedFromScores.some(
      memory => memory.contextType === 'lore'
    );
    logger.info(
      `Memory score fallback selected for user=${userId}: ${fallbackSelectedFromScores.map(summarizeMemory).join(', ')}`
    );
    return {
      context: buildMemoryContext(fallbackSelectedFromScores),
      selected: fallbackSelectedFromScores,
      shouldMention: isIdentityQuery && fallbackHasLore,
      mentionConfidence: 0,
      usedFallback: true
    };
  }

  if (!allowFallback) {
    return {
      context: '',
      selected: [],
      shouldMention: false,
      mentionConfidence: 0,
      usedFallback: false
    };
  }

  const latestFallback = isIdentityQuery
    ? [
        ...(await db.getServerMemories(serverId, 'lore', memoryConfig.fallbackLimit)),
        ...(await db.getServerMemories(serverId, 'persona', memoryConfig.fallbackLimit))
      ].slice(0, memoryConfig.fallbackLimit)
    : await db.getServerMemories(serverId, undefined, memoryConfig.fallbackLimit);
  const latestFallbackHasLore = latestFallback.some(memory => memory.contextType === 'lore');
  if (latestFallback.length > 0) {
    logger.info(
      `Memory latest fallback selected for user=${userId}: ${latestFallback.map(summarizeMemory).join(', ')}`
    );
  }
  return {
    context: buildMemoryContext(latestFallback),
    selected: latestFallback,
    shouldMention: isIdentityQuery && latestFallbackHasLore,
    mentionConfidence: 0,
    usedFallback: latestFallback.length > 0
  };
}
