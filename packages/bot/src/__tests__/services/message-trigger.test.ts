import { describe, expect, mock, test } from 'bun:test';
import { shouldHandleAssistantMessage } from '../../services/message-trigger';

function createMessage(params: {
  mentionsBot?: boolean;
  referenceAuthorId?: string | null;
  fetchFails?: boolean;
}) {
  return {
    mentions: {
      has: mock(() => Boolean(params.mentionsBot))
    },
    reference:
      params.referenceAuthorId !== undefined || params.fetchFails
        ? { messageId: 'referenced-message' }
        : null,
    fetchReference: mock(async () => {
      if (params.fetchFails) {
        throw new Error('missing reference');
      }

      return {
        author: {
          id: params.referenceAuthorId
        }
      };
    })
  };
}

describe('shouldHandleAssistantMessage', () => {
  test('handles direct bot mentions without fetching reply context', async () => {
    const message = createMessage({ mentionsBot: true });

    await expect(shouldHandleAssistantMessage(message, 'bot-1')).resolves.toBe(true);
    expect(message.fetchReference).not.toHaveBeenCalled();
  });

  test('handles replies to the bot even without a mention', async () => {
    const message = createMessage({ referenceAuthorId: 'bot-1' });

    await expect(shouldHandleAssistantMessage(message, 'bot-1')).resolves.toBe(true);
  });

  test('ignores replies to other users and missing references', async () => {
    await expect(
      shouldHandleAssistantMessage(createMessage({ referenceAuthorId: 'user-1' }), 'bot-1')
    ).resolves.toBe(false);

    await expect(
      shouldHandleAssistantMessage(createMessage({ fetchFails: true }), 'bot-1')
    ).resolves.toBe(false);
  });
});
