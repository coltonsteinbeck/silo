import type { ImageProvider } from '@silo/core';
import type { AssembledConversationContext } from './conversation-context';

export const VISION_PROVIDER_REQUIRED_MESSAGE =
    '⚠️ This request includes image context, but the configured provider does not support vision. Switch providers with /config first.';

export interface VisionRoutingDecision {
    useVision: boolean;
    estimatedVisionTokens: number;
    errorMessage: string | null;
}

export interface VisionRoutingReplyTarget {
    reply(payload: { content: string; allowedMentions: { repliedUser: boolean } }): Promise<unknown>;
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
        allowedMentions: { repliedUser: false }
    });

    return true;
}
