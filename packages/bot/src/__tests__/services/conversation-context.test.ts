import { describe, test, expect } from 'bun:test';
import {
  assembleConversationContext,
  buildImageSummaryBlock
} from '../../services/conversation-context';

describe('conversation-context', () => {
  test('keeps referenced content for storage but excludes it from merged user prompt', () => {
    const context = assembleConversationContext({
      processedContent: 'Has he gone guru?',
      currentImageUrls: [],
      replyContext: {
        chain: [],
        directReplyMessageId: 'm_ref',
        directReplyUserId: 'u_ref',
        textContext: '[Reply level 1 | user u_ref]\nSome prior message'
      }
    });

    expect(context.referencedContent).toContain('Some prior message');
    expect(context.mergedUserContent).toBe('Has he gone guru?');
    expect(context.directReplyMessageId).toBe('m_ref');
    expect(context.directReplyUserId).toBe('u_ref');
  });

  test('orders vision targets current first then replies and applies cap', () => {
    const context = assembleConversationContext({
      processedContent: 'What is happening?',
      currentImageUrls: ['https://img.test/current.png'],
      replyContext: {
        chain: [
          {
            messageId: 'r1',
            userId: 'u1',
            content: 'reply 1',
            imageUrls: ['https://img.test/reply1-a.png', 'https://img.test/reply1-b.png']
          },
          {
            messageId: 'r2',
            userId: 'u2',
            content: 'reply 2',
            imageUrls: ['https://img.test/reply2.png']
          }
        ],
        directReplyMessageId: 'r1',
        directReplyUserId: 'u1',
        textContext: 'prior context'
      },
      maxVisionTargets: 2
    });

    expect(context.visionTargets).toHaveLength(2);
    expect(context.visionTargets[0]).toEqual({
      url: 'https://img.test/current.png',
      source: 'current',
      replyDepth: null
    });
    expect(context.visionTargets[1]).toEqual({
      url: 'https://img.test/reply1-a.png',
      source: 'reply',
      replyDepth: 1
    });
  });

  test('buildImageSummaryBlock formats summaries and handles empty input', () => {
    expect(buildImageSummaryBlock([])).toBe('');

    const block = buildImageSummaryBlock([
      '[1|current] person dancing',
      '[2|reply_level_1] meme panel'
    ]);
    expect(block).toContain('Image context summary:');
    expect(block).toContain('Image 1: [1|current] person dancing');
    expect(block).toContain('Image 2: [2|reply_level_1] meme panel');
  });
});
