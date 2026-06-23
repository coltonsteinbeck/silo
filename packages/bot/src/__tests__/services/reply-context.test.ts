import { describe, test, expect } from 'bun:test';
import type { Message } from 'discord.js';
import { resolveReplyContext } from '../../services/reply-context';

type Attachment = {
  url: string;
  contentType?: string;
  size: number;
};

function createAttachmentCollection(items: Attachment[]) {
  return {
    filter(predicate: (item: Attachment) => boolean) {
      return createAttachmentCollection(items.filter(predicate));
    },
    map<T>(mapper: (item: Attachment) => T): T[] {
      return items.map(mapper);
    }
  };
}

function createMockMessage(opts: {
  id: string;
  userId?: string;
  content?: string;
  referenceMessageId?: string;
  attachments?: Attachment[];
  referenced?: Message<boolean>;
  throwOnFetch?: boolean;
  bot?: boolean;
}): Message<boolean> {
  return {
    id: opts.id,
    content: opts.content || '',
    author: { id: opts.userId || 'u1', bot: Boolean(opts.bot) },
    reference: opts.referenceMessageId ? { messageId: opts.referenceMessageId } : null,
    attachments: createAttachmentCollection(opts.attachments || []),
    fetchReference: async () => {
      if (opts.throwOnFetch) {
        throw new Error('fetch failed');
      }
      return opts.referenced as Message<boolean>;
    }
  } as unknown as Message<boolean>;
}

describe('resolveReplyContext', () => {
  test('returns empty context when message is not a reply', async () => {
    const message = createMockMessage({
      id: 'm1',
      content: 'hello world'
    });

    const result = await resolveReplyContext(message, 2);

    expect(result.chain).toHaveLength(0);
    expect(result.directReplyMessageId).toBeNull();
    expect(result.directReplyUserId).toBeNull();
    expect(result.textContext).toBe('');
  });

  test('resolves reply chain up to max depth and extracts image attachments', async () => {
    const replyLevel2 = createMockMessage({
      id: 'm_ref_2',
      userId: 'u_ref_2',
      content: 'older message',
      attachments: [{ url: 'https://img.test/2.png', contentType: 'image/png', size: 1024 }]
    });

    const replyLevel1 = createMockMessage({
      id: 'm_ref_1',
      userId: 'u_ref_1',
      content: ' recent   message  ',
      referenceMessageId: 'm_ref_2',
      attachments: [
        { url: 'https://img.test/1.png', contentType: 'image/png', size: 1024 },
        { url: 'https://file.test/not-image.txt', contentType: 'text/plain', size: 10 },
        { url: 'https://img.test/too-big.png', contentType: 'image/png', size: 25 * 1024 * 1024 }
      ],
      referenced: replyLevel2
    });

    const message = createMockMessage({
      id: 'm_current',
      content: 'current',
      referenceMessageId: 'm_ref_1',
      referenced: replyLevel1
    });

    const result = await resolveReplyContext(message, 2);

    expect(result.chain).toHaveLength(2);
    expect(result.chain[0]?.messageId).toBe('m_ref_1');
    expect(result.chain[0]?.content).toBe('recent message');
    expect(result.chain[0]?.imageUrls).toEqual(['https://img.test/1.png']);
    expect(result.chain[1]?.messageId).toBe('m_ref_2');
    expect(result.chain[1]?.imageUrls).toEqual(['https://img.test/2.png']);

    expect(result.directReplyMessageId).toBe('m_ref_1');
    expect(result.directReplyUserId).toBe('u_ref_1');
    expect(result.textContext).toContain('[Reply level 1 | user u_ref_1]');
    expect(result.textContext).toContain('[Reply level 2 | user u_ref_2]');
  });

  test('gracefully handles missing/inaccessible referenced message', async () => {
    const message = createMockMessage({
      id: 'm1',
      content: 'current',
      referenceMessageId: 'missing',
      throwOnFetch: true
    });

    const result = await resolveReplyContext(message, 2);

    expect(result.chain).toHaveLength(0);
    expect(result.directReplyMessageId).toBeNull();
    expect(result.textContext).toBe('');
  });

  test('neutralizes Discord mass mentions in referenced context', async () => {
    const referenced = createMockMessage({
      id: 'm_ref_1',
      userId: 'bot_user',
      content: '@everyone and @HERE should not become active mentions'
    });

    const message = createMockMessage({
      id: 'm_current',
      content: 'make it harsher',
      referenceMessageId: 'm_ref_1',
      referenced
    });

    const result = await resolveReplyContext(message, 2);

    expect(result.chain[0]?.content).toBe('everyone and here should not become active mentions');
    expect(result.textContext).not.toContain('@everyone');
    expect(result.textContext).not.toContain('@HERE');
    expect(result.textContext).toContain('everyone and here');
  });

  test('omits generic bot refusal from referenced context', async () => {
    const referenced = createMockMessage({
      id: 'm_ref_1',
      userId: 'bot_user',
      bot: true,
      content:
        'I can’t help with that request. Please rephrase and I can provide a safer alternative.'
    });

    const message = createMockMessage({
      id: 'm_current',
      content: 'Thanks',
      referenceMessageId: 'm_ref_1',
      referenced
    });

    const result = await resolveReplyContext(message, 2);

    expect(result.chain[0]?.content).toBe('');
    expect(result.chain[0]?.isBot).toBe(true);
    expect(result.chain[0]?.omittedReason).toBe('blocked_safety_fallback');
    expect(result.textContext).toContain('[Reply level 1 | user bot_user]');
    expect(result.textContext).not.toContain('I can’t help with that request');
  });

  test('omits unsafe bot banter residue from referenced context', async () => {
    const referenced = createMockMessage({
      id: 'm_ref_1',
      userId: 'bot_user',
      bot: true,
      content:
        "ban Mr Balls first. He's clearly the final boss of this cursed group. Proceed with extreme prejudice."
    });

    const message = createMockMessage({
      id: 'm_current',
      content: "I can't do that it's almost Father's Day",
      referenceMessageId: 'm_ref_1',
      referenced
    });

    const result = await resolveReplyContext(message, 2);

    expect(result.chain[0]?.content).toBe('');
    expect(result.chain[0]?.omittedReason).toBe('unsafe_banter_residue');
    expect(result.textContext).not.toContain('Proceed with extreme prejudice');
    expect(result.textContext).not.toContain('ban Mr Balls first');
  });
});
