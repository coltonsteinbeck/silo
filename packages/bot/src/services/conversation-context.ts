import type { ResolvedReplyContext } from './reply-context';

export interface VisionTarget {
  url: string;
  source: 'current' | 'reply';
  replyDepth: number | null;
}

export interface AssembledConversationContext {
  mergedUserContent: string;
  referencedContent: string;
  visionTargets: VisionTarget[];
  directReplyMessageId: string | null;
  directReplyUserId: string | null;
}

interface AssembleConversationContextArgs {
  processedContent: string;
  currentImageUrls: string[];
  replyContext: ResolvedReplyContext;
  maxVisionTargets?: number;
  includeReplyImagesInVision?: boolean;
}

export function assembleConversationContext({
  processedContent,
  currentImageUrls,
  replyContext,
  maxVisionTargets = 2,
  includeReplyImagesInVision = false
}: AssembleConversationContextArgs): AssembledConversationContext {
  const referencedContent = replyContext.textContext;
  // Keep reference context for storage/auditing, but do not inject it into live prompts.
  const mergedUserContent = processedContent;

  const currentTargets: VisionTarget[] = currentImageUrls.map(url => ({
    url,
    source: 'current',
    replyDepth: null
  }));

  const replyTargets: VisionTarget[] = includeReplyImagesInVision
    ? replyContext.chain.flatMap((entry, index) =>
        entry.imageUrls.map(url => ({
          url,
          source: 'reply' as const,
          replyDepth: index + 1
        }))
      )
    : [];

  const visionTargets = [...currentTargets, ...replyTargets].slice(0, maxVisionTargets);

  return {
    mergedUserContent,
    referencedContent,
    visionTargets,
    directReplyMessageId: replyContext.directReplyMessageId,
    directReplyUserId: replyContext.directReplyUserId
  };
}

export function buildImageSummaryBlock(summaries: string[]): string {
  if (summaries.length === 0) {
    return '';
  }

  return [
    'Private image grounding:',
    ...summaries.map((summary, index) => `- Image ${index + 1}: ${summary}`)
  ].join('\n');
}

export function buildEffectiveUserPrompt(params: {
  userText: string;
  hasVisionTargets: boolean;
}): string {
  return params.userText.replace(/\s+/g, ' ').trim();
}

const CASUAL_CHECK_IN =
  /\b(how'?s it hanging|how are (?:you|ya|u)|how'?s it going|how you doing|what'?s up|sup\b|how'?s life|how are things|you good|how'?s your day|wyd)\b/i;
const NON_STANDALONE_CONTEXT =
  /\b(and|also|plus|with|about|that|those|again|still|earlier|previous|last|remember|you said|we were|nba|finals?|score|scores?|patch|search|draw|image|video|url|link)\b/i;

export function isStandaloneCasualCheckIn(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 80 || /https?:\/\//i.test(normalized)) {
    return false;
  }

  return CASUAL_CHECK_IN.test(normalized) && !NON_STANDALONE_CONTEXT.test(normalized);
}

export function shouldIncludeConversationHistoryForPrompt(params: {
  latestUserText: string;
  hasReplyContext: boolean;
  hasVisionTargets: boolean;
}): boolean {
  const normalized = params.latestUserText.replace(/\s+/g, ' ').trim();
  if (!normalized || isStandaloneCasualCheckIn(normalized)) {
    return false;
  }

  if (params.hasReplyContext || params.hasVisionTargets) {
    return true;
  }

  return true;
}

export function buildConversationHistoryInstruction(historyIncluded: boolean): string {
  if (!historyIncluded) {
    return '\n\nConversation history rule: Treat this as a standalone casual check-in. Do not mention or revive prior channel topics unless the user brings them up.';
  }

  return '\n\nConversation history rule: Use prior channel history quietly for continuity, reference resolution, and direct follow-ups. Do not proactively bring up older topics during greetings or small talk unless the latest user message clearly asks about them.';
}
