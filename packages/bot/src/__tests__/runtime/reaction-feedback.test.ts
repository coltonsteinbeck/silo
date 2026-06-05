import { describe, expect, mock, test } from 'bun:test';
import { handleReactionFeedback, mapFeedbackEmoji } from '../../runtime/reaction-feedback';

function createLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  };
}

describe('reaction feedback', () => {
  test('maps supported feedback emojis', () => {
    expect(mapFeedbackEmoji('👍')).toBe('positive');
    expect(mapFeedbackEmoji('👎')).toBe('negative');
    expect(mapFeedbackEmoji('🔄')).toBe('regenerate');
    expect(mapFeedbackEmoji('💾')).toBe('save');
    expect(mapFeedbackEmoji('🗑️')).toBe('delete');
    expect(mapFeedbackEmoji('x')).toBeNull();
  });

  test('logs feedback for bot messages', async () => {
    const logFeedback = mock(async () => {});
    const reaction = {
      partial: false,
      emoji: { name: '👍' },
      message: {
        id: 'message-1',
        channelId: 'channel-1',
        guildId: 'guild-1',
        author: { id: 'bot-1' },
        deletable: false
      }
    };

    await handleReactionFeedback({
      reaction: reaction as never,
      user: { id: 'user-1', bot: false } as never,
      client: { user: { id: 'bot-1' } } as never,
      adminDb: { logFeedback } as never,
      permissions: {} as never,
      log: createLogger()
    });

    expect(logFeedback).toHaveBeenCalledWith({
      messageId: 'message-1',
      channelId: 'channel-1',
      guildId: 'guild-1',
      userId: 'user-1',
      feedbackType: 'positive'
    });
  });

  test('allows original requester to delete bot response', async () => {
    const logFeedback = mock(async () => {});
    const deleteMessage = mock(async () => {});
    const reaction = {
      partial: false,
      emoji: { name: '🗑️' },
      message: {
        id: 'message-1',
        channelId: 'channel-1',
        guildId: 'guild-1',
        author: { id: 'bot-1' },
        interaction: { user: { id: 'user-1' } },
        deletable: true,
        delete: deleteMessage
      }
    };

    await handleReactionFeedback({
      reaction: reaction as never,
      user: { id: 'user-1', bot: false } as never,
      client: { user: { id: 'bot-1' } } as never,
      adminDb: { logFeedback } as never,
      permissions: {} as never,
      log: createLogger()
    });

    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });
});
