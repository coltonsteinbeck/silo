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
}

export function assembleConversationContext({
  processedContent,
  currentImageUrls,
  replyContext,
  maxVisionTargets = 2
}: AssembleConversationContextArgs): AssembledConversationContext {
  const referencedContent = replyContext.textContext;
  // Keep reference context for storage/auditing, but do not inject it into live prompts.
  const mergedUserContent = processedContent;

  const currentTargets: VisionTarget[] = currentImageUrls.map(url => ({
    url,
    source: 'current',
    replyDepth: null
  }));

  const replyTargets: VisionTarget[] = replyContext.chain.flatMap((entry, index) =>
    entry.imageUrls.map(url => ({
      url,
      source: 'reply' as const,
      replyDepth: index + 1
    }))
  );

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
    'Image context summary:',
    ...summaries.map((summary, index) => `- Image ${index + 1}: ${summary}`)
  ].join('\n');
}
