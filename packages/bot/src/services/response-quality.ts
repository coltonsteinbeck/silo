export interface ResponseQualityResult {
  repetitive: boolean;
  reason: 'high_similarity' | 'recurring_phrases' | null;
  maxSimilarity: number;
  recurringPhraseCount: number;
}

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'before',
  'being',
  'could',
  'from',
  'have',
  'into',
  'just',
  'more',
  'that',
  'their',
  'there',
  'these',
  'they',
  'this',
  'those',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
  'your'
]);

const EXPLICIT_REPEAT_REQUEST_PATTERN =
  /\b(?:repeat\s+(?:that|your\s+(?:last|previous)\s+(?:answer|response)|the\s+(?:last|previous)\s+(?:answer|response))|quote\s+(?:that|your\s+(?:last|previous)\s+(?:answer|response))|say\s+that\s+again|same\s+answer\s+(?:again|verbatim)|(?:repeat|quote)\s+it\s+(?:exactly|verbatim)|(?:the\s+)?(?:full|whole)\s+(?:thing|answer|response|list)|all\s+at\s+once|you\s+stopped|(?:please\s+)?(?:continue|go\s+on|finish(?:\s+it|\s+the\s+(?:list|answer))?)|start\s+over|from\s+the\s+beginning|i\s+meant(?:\s+it)?\s+to\b|i\s+need\s+it\s+to\b)\b/i;
const LOW_INFORMATION_TASK_FOLLOW_UP =
  /^(?:why|what|how|do\s+it|can\s+you|try\s+again|no|nope|not\s+that|fix\s+it)[.!?]*$/i;

export function isExplicitResponseContinuationRequest(text: string): boolean {
  return EXPLICIT_REPEAT_REQUEST_PATTERN.test(text);
}

export function selectLatestTaskDefiningUserText(userTexts: string[]): string | null {
  const normalized = userTexts.map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const taskDefining = [...normalized]
    .reverse()
    .find(
      text =>
        !isExplicitResponseContinuationRequest(text) && !LOW_INFORMATION_TASK_FOLLOW_UP.test(text)
    );

  return taskDefining || normalized.at(-1) || null;
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’]+/gu, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
}

function buildNgrams(tokens: string[], size: number): Set<string> {
  const ngrams = new Set<string>();
  for (let index = 0; index <= tokens.length - size; index += 1) {
    ngrams.add(tokens.slice(index, index + size).join(' '));
  }
  return ngrams;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }

  return intersection / (left.size + right.size - intersection);
}

function normalizeComparableText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectResponseRepetition(params: {
  candidate: string;
  recentAssistantMessages: string[];
  latestUserText: string;
}): ResponseQualityResult {
  const candidateTokens = normalizeTokens(params.candidate);
  if (
    params.recentAssistantMessages.length === 0 ||
    isExplicitResponseContinuationRequest(params.latestUserText)
  ) {
    return {
      repetitive: false,
      reason: null,
      maxSimilarity: 0,
      recurringPhraseCount: 0
    };
  }

  if (candidateTokens.length < 6) {
    const normalizedCandidate = normalizeComparableText(params.candidate);
    const shortNearDuplicate =
      normalizedCandidate.length >= 20 &&
      params.recentAssistantMessages.slice(-3).some(message => {
        const normalizedRecent = normalizeComparableText(message);
        if (normalizedCandidate === normalizedRecent) {
          return true;
        }

        const shorterLength = Math.min(normalizedCandidate.length, normalizedRecent.length);
        const longerLength = Math.max(normalizedCandidate.length, normalizedRecent.length);
        return (
          shorterLength / Math.max(1, longerLength) >= 0.85 &&
          (normalizedCandidate.includes(normalizedRecent) ||
            normalizedRecent.includes(normalizedCandidate))
        );
      });

    return {
      repetitive: shortNearDuplicate,
      reason: shortNearDuplicate ? 'high_similarity' : null,
      maxSimilarity: shortNearDuplicate ? 1 : 0,
      recurringPhraseCount: 0
    };
  }

  const candidateTrigrams = buildNgrams(candidateTokens, 3);
  const recent = params.recentAssistantMessages.slice(-3).map(normalizeTokens);
  const similarities = recent.map(tokens => jaccard(candidateTrigrams, buildNgrams(tokens, 3)));
  const maxSimilarity = Math.max(0, ...similarities);

  const userBigrams = buildNgrams(normalizeTokens(params.latestUserText), 2);
  const candidateBigrams = buildNgrams(candidateTokens, 2);
  const recurrenceCounts = new Map<string, number>();
  for (const tokens of recent) {
    for (const phrase of buildNgrams(tokens, 2)) {
      if (!userBigrams.has(phrase)) {
        recurrenceCounts.set(phrase, (recurrenceCounts.get(phrase) || 0) + 1);
      }
    }
  }

  const recurringPhraseCount = Array.from(recurrenceCounts.entries()).filter(
    ([phrase, count]) => count >= 2 && candidateBigrams.has(phrase)
  ).length;
  const reason =
    maxSimilarity >= 0.35
      ? 'high_similarity'
      : recurringPhraseCount >= 3
        ? 'recurring_phrases'
        : null;

  return {
    repetitive: Boolean(reason),
    reason,
    maxSimilarity,
    recurringPhraseCount
  };
}
