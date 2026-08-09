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
const LOW_INFORMATION_FOLLOW_UP =
  /^(?:thanks?|thank you|ty|ok|okay|k|cool|nice|yep|yeah|yes|nah|no|nope|lol|lmao|haha|huh|please|pls|maybe|maybe you can|\?+|!+)$/i;
const STANDALONE_STYLE_REQUEST =
  /^(?:(?:please|now)\s+)?(?:talk|speak|respond|write|act)\s+like\b|^be\s+(?:nice|nicer|mean|meaner)(?:\s+to\s+me)?$/i;
const STANDALONE_CONVERSATION_REQUEST =
  /^(?:(?:please|now)\s+)?(?:talk|chat|speak)\s+(?:to|with)\s+me$|^(?:please\s+)?(?:say|tell\s+me)\s+something$/i;
const HARMLESS_REFUSAL_FOLLOW_UP = /\bi\s+can(?:'|’)?t\s+do\s+that\b/i;
const REFUSAL_LOOP_RESET =
  /\b(?:all\s+you\s+(?:ever\s+)?say\s+is\s+no|you\s+(?:only|just)\s+say\s+no|why\s+do\s+you\s+keep\s+(?:refusing|saying\s+no)|stop\s+(?:refusing|saying\s+no)|you\s+(?:keep|kept)\s+(?:refusing|saying\s+no)|can(?:'|’)?t\s+answer\s+anything|won(?:'|’)?t\s+answer\s+anything|guardrails?\s+(?:keep|keeps|kept)\s+(?:triggering|tripping)|trips?\s+the\s+wires?)\b/i;

export function isStandaloneCasualCheckIn(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 80 || /https?:\/\//i.test(normalized)) {
    return false;
  }

  return CASUAL_CHECK_IN.test(normalized) && !NON_STANDALONE_CONTEXT.test(normalized);
}

export function isLowContextStandaloneTurn(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 120 || /https?:\/\//i.test(normalized)) {
    return false;
  }

  const plain = normalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}?!. '’]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const plainWithoutTrailingPunctuation = plain.replace(/[?!.]+$/g, '').trim();

  if (
    LOW_INFORMATION_FOLLOW_UP.test(plain) ||
    LOW_INFORMATION_FOLLOW_UP.test(plainWithoutTrailingPunctuation)
  ) {
    return true;
  }

  if (HARMLESS_REFUSAL_FOLLOW_UP.test(plainWithoutTrailingPunctuation)) {
    return true;
  }

  if (isRefusalLoopResetTurn(plainWithoutTrailingPunctuation)) {
    return true;
  }

  return (
    (STANDALONE_STYLE_REQUEST.test(plainWithoutTrailingPunctuation) ||
      STANDALONE_CONVERSATION_REQUEST.test(plainWithoutTrailingPunctuation)) &&
    !NON_STANDALONE_CONTEXT.test(plainWithoutTrailingPunctuation)
  );
}

export function isRefusalLoopResetTurn(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 180 || /https?:\/\//i.test(normalized)) {
    return false;
  }

  return REFUSAL_LOOP_RESET.test(normalized);
}

export function shouldIncludeConversationHistoryForPrompt(params: {
  latestUserText: string;
  hasReplyContext: boolean;
  hasVisionTargets: boolean;
}): boolean {
  const normalized = params.latestUserText.replace(/\s+/g, ' ').trim();
  if (
    !normalized ||
    isStandaloneCasualCheckIn(normalized) ||
    isLowContextStandaloneTurn(normalized)
  ) {
    return false;
  }

  if (params.hasReplyContext || params.hasVisionTargets) {
    return true;
  }

  return true;
}

export function buildConversationHistoryInstruction(historyIncluded: boolean): string {
  if (!historyIncluded) {
    return '\n\nConversation history rule: Treat this as a standalone low-context turn. Do not mention or revive prior channel topics unless the user brings them up in the latest message.';
  }

  return '\n\nConversation history rule: Use only the selected reply-chain or same-user turns below for continuity and reference resolution. Do not treat assistant inventions as established lore, and do not bring up older topics unless the latest user message clearly asks about them.';
}
