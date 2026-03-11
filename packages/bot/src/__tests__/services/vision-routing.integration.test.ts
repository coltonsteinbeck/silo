import { describe, test, expect } from 'bun:test';
import type { ImageProvider } from '@silo/core';
import { assembleConversationContext } from '../../services/conversation-context';
import {
    decideVisionRouting,
    enforceVisionRoutingPrecheck,
    VISION_PROVIDER_REQUIRED_MESSAGE
} from '../../services/vision-routing';

function createVisionProvider(): ImageProvider {
    return {
        name: 'mock-vision',
        isConfigured: () => true,
        generateImage: async () => ({ url: 'https://img.test/generated.png' }),
        analyzeImage: async () => ({ content: 'summary' })
    };
}

describe('vision routing integration seam', () => {
    test('hard-fails when reply/image context exists without a vision provider', () => {
        const context = assembleConversationContext({
            processedContent: 'what is he talking about?',
            currentImageUrls: [],
            replyContext: {
                chain: [
                    {
                        messageId: 'm_ref',
                        userId: 'u_ref',
                        content: 'a previous message with image',
                        imageUrls: ['https://img.test/reply.png']
                    }
                ],
                directReplyMessageId: 'm_ref',
                directReplyUserId: 'u_ref',
                textContext: '[Reply level 1 | user u_ref]\na previous message with image'
            },
            maxVisionTargets: 2
        });

        const decision = decideVisionRouting(context, null);

        expect(decision.useVision).toBe(false);
        expect(decision.estimatedVisionTokens).toBe(0);
        expect(decision.errorMessage).toBe(VISION_PROVIDER_REQUIRED_MESSAGE);
    });

    test('precheck sends handler reply payload for missing vision provider', async () => {
        const replies: Array<{ content: string; allowedMentions: { repliedUser: boolean } }> = [];
        const target = {
            reply: async (payload: { content: string; allowedMentions: { repliedUser: boolean } }) => {
                replies.push(payload);
            }
        };

        const blocked = await enforceVisionRoutingPrecheck(target, {
            useVision: false,
            estimatedVisionTokens: 0,
            errorMessage: VISION_PROVIDER_REQUIRED_MESSAGE
        });

        expect(blocked).toBe(true);
        expect(replies).toHaveLength(1);
        expect(replies[0]).toEqual({
            content: VISION_PROVIDER_REQUIRED_MESSAGE,
            allowedMentions: { repliedUser: false }
        });
    });

    test('uses vision and estimates quota when a vision provider is available', () => {
        const context = assembleConversationContext({
            processedContent: 'describe this',
            currentImageUrls: ['https://img.test/current.png'],
            replyContext: {
                chain: [],
                directReplyMessageId: null,
                directReplyUserId: null,
                textContext: ''
            },
            maxVisionTargets: 2
        });

        const decision = decideVisionRouting(context, createVisionProvider());

        expect(decision.useVision).toBe(true);
        expect(decision.estimatedVisionTokens).toBe(1000);
        expect(decision.errorMessage).toBeNull();
    });
});
