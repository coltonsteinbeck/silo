import { describe, test, expect } from 'bun:test';
import {
  assembleConversationContext,
  buildEffectiveUserPrompt,
  buildConversationHistoryInstruction,
  isRefusalLoopResetTurn,
  isLowContextStandaloneTurn,
  shouldIncludeConversationHistoryForPrompt,
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

  test('uses current-message images only by default for vision targets', () => {
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

    expect(context.visionTargets).toHaveLength(1);
    expect(context.visionTargets[0]).toEqual({
      url: 'https://img.test/current.png',
      source: 'current',
      replyDepth: null
    });
  });

  test('can include reply images in vision targets when explicitly enabled', () => {
    const context = assembleConversationContext({
      processedContent: 'What is happening?',
      currentImageUrls: ['https://img.test/current.png'],
      replyContext: {
        chain: [
          {
            messageId: 'r1',
            userId: 'u1',
            content: 'reply 1',
            imageUrls: ['https://img.test/reply1-a.png']
          }
        ],
        directReplyMessageId: 'r1',
        directReplyUserId: 'u1',
        textContext: 'prior context'
      },
      maxVisionTargets: 2,
      includeReplyImagesInVision: true
    });

    expect(context.visionTargets).toHaveLength(2);
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
    expect(block).toContain('Private image grounding:');
    expect(block).toContain('Image 1: [1|current] person dancing');
    expect(block).toContain('Image 2: [2|reply_level_1] meme panel');
  });

  test('buildEffectiveUserPrompt leaves image-only turns directive-free', () => {
    expect(buildEffectiveUserPrompt({ userText: '', hasVisionTargets: false })).toBe('');
    expect(
      buildEffectiveUserPrompt({ userText: '  what is this?  ', hasVisionTargets: true })
    ).toBe('what is this?');
    expect(buildEffectiveUserPrompt({ userText: '', hasVisionTargets: true })).toBe('');
  });

  test('omits prior history for standalone casual check-ins', () => {
    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: "how's it hanging?",
        hasReplyContext: false,
        hasVisionTargets: false
      })
    ).toBe(false);

    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: 'how are you?',
        hasReplyContext: false,
        hasVisionTargets: false
      })
    ).toBe(false);
  });

  test('omits prior history for low-context replies from trace regressions', () => {
    for (const latestUserText of [
      'Thanks',
      'maybe you can?',
      "I can't do that it's almost Father's Day",
      'apparenlly all you say is no',
      'why do you keep refusing',
      'now talk like a pirate',
      'please talk like a pirate captain in the 1600s',
      'be nice'
    ]) {
      expect(isLowContextStandaloneTurn(latestUserText)).toBe(true);
      expect(
        shouldIncludeConversationHistoryForPrompt({
          latestUserText,
          hasReplyContext: true,
          hasVisionTargets: false
        })
      ).toBe(false);
    }
  });

  test('detects harmless refusal-loop reset turns', () => {
    expect(isRefusalLoopResetTurn('apparenlly all you say is no')).toBe(true);
    expect(isRefusalLoopResetTurn('why do you keep refusing')).toBe(true);
    expect(isRefusalLoopResetTurn('what did you mean by that?')).toBe(false);
    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: 'apparenlly all you say is no',
        hasReplyContext: true,
        hasVisionTargets: false
      })
    ).toBe(false);
  });

  test('keeps history for topical prompts and vision turns with text', () => {
    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: "how's it hanging with the NBA finals?",
        hasReplyContext: false,
        hasVisionTargets: false
      })
    ).toBe(true);

    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: 'what did you say earlier?',
        hasReplyContext: false,
        hasVisionTargets: false
      })
    ).toBe(true);

    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: 'what did you mean by that?',
        hasReplyContext: true,
        hasVisionTargets: false
      })
    ).toBe(true);

    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: '',
        hasReplyContext: false,
        hasVisionTargets: true
      })
    ).toBe(false);

    expect(
      shouldIncludeConversationHistoryForPrompt({
        latestUserText: 'what is happening in this image?',
        hasReplyContext: false,
        hasVisionTargets: true
      })
    ).toBe(true);
  });

  test('keeps history for context-dependent follow-ups', () => {
    for (const latestUserText of ['continue', 'go on', 'do it', 'why', 'what', 'can you']) {
      expect(isLowContextStandaloneTurn(latestUserText)).toBe(false);
      expect(
        shouldIncludeConversationHistoryForPrompt({
          latestUserText,
          hasReplyContext: true,
          hasVisionTargets: false
        })
      ).toBe(true);
    }
  });

  test('buildConversationHistoryInstruction keeps prior topics subtle', () => {
    expect(buildConversationHistoryInstruction(true)).toContain(
      'Use prior channel history quietly'
    );
    expect(buildConversationHistoryInstruction(true)).toContain(
      'Do not proactively bring up older topics'
    );
    expect(buildConversationHistoryInstruction(false)).toContain('standalone low-context turn');
  });
});
