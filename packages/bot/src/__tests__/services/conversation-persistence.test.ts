import { describe, expect, test } from 'bun:test';
import type { ConversationMessage } from '@silo/core';
import { buildConversationPersistenceMessages } from '../../services/conversation-persistence';

function createMessage(
  role: ConversationMessage['role'],
  content: string
): Omit<ConversationMessage, 'id' | 'createdAt'> {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: role === 'assistant' ? 'bot-1' : 'user-1',
    promptHash: 'prompt-1',
    role,
    content,
    replyToMessageId: null,
    replyToUserId: null,
    referencedContent: null,
    imageSummary: null
  };
}

describe('conversation persistence helpers', () => {
  test('stores user and assistant turns when output is safe', () => {
    const messages = buildConversationPersistenceMessages({
      userMessage: createMessage('user', 'hello'),
      assistantMessage: createMessage('assistant', 'hello back'),
      outputBlockedBySafety: false
    });

    expect(messages.map(message => message.role)).toEqual(['user', 'assistant']);
  });

  test('skips blocked assistant fallback while keeping user turn', () => {
    const messages = buildConversationPersistenceMessages({
      userMessage: createMessage('user', 'continue the unsafe bit'),
      assistantMessage: createMessage(
        'assistant',
        'Nope. That one trips the wires. Rephrase it less cursed and I can help.'
      ),
      outputBlockedBySafety: true
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('continue the unsafe bit');
  });
});
