import type { ImageProvider } from '@silo/core';
import type { AssembledConversationContext } from './conversation-context';

export const VISION_PROVIDER_REQUIRED_MESSAGE =
  'I can’t analyze images right now. Please describe the image in text, or try again later.';

export function buildVisionResponseInstruction(useVision: boolean): string {
  if (!useVision) {
    return '';
  }

  return '\n\nImage response rule: Use visual grounding silently and answer the latest user request directly in the configured persona. For an image-only turn, give a brief in-character reaction. Do not prepend an image description, list visual details, repeat the private grounding notes, or offer a caption menu. Describe the image only when the user explicitly asks for a description, identification, or visible text; provide those requested details as the answer.';
}

export interface VisionRoutingDecision {
  useVision: boolean;
  estimatedVisionTokens: number;
  errorMessage: string | null;
}

export interface VisionRoutingReplyTarget {
  reply(payload: {
    content: string;
    allowedMentions: { repliedUser: boolean; parse: [] };
  }): Promise<unknown>;
}

export function decideVisionRouting(
  context: AssembledConversationContext,
  visionProvider: ImageProvider | null
): VisionRoutingDecision {
  const visionTargetCount = context.visionTargets.length;

  if (visionTargetCount === 0) {
    return {
      useVision: false,
      estimatedVisionTokens: 0,
      errorMessage: null
    };
  }

  if (!visionProvider?.analyzeImage) {
    return {
      useVision: false,
      estimatedVisionTokens: 0,
      errorMessage: VISION_PROVIDER_REQUIRED_MESSAGE
    };
  }

  return {
    useVision: true,
    estimatedVisionTokens: visionTargetCount * 1000,
    errorMessage: null
  };
}

export async function enforceVisionRoutingPrecheck(
  target: VisionRoutingReplyTarget,
  decision: VisionRoutingDecision
): Promise<boolean> {
  if (!decision.errorMessage) {
    return false;
  }

  await target.reply({
    content: decision.errorMessage,
    allowedMentions: { repliedUser: false, parse: [] }
  });

  return true;
}
