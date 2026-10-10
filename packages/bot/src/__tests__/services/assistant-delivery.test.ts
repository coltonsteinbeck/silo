import { expect, mock, test } from 'bun:test';
import type { Message } from 'discord.js';
import { deliverAssistantReply } from '../../services/assistant-delivery';

test('a cancelled final reply never starts a Discord send', () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled before delivery'));
  const reply = mock(async () => ({ id: 'must-not-send' }));
  expect(() =>
    deliverAssistantReply(
      { reply } as unknown as Pick<Message, 'reply'>,
      'Late content',
      [],
      controller.signal
    )
  ).toThrow('cancelled before delivery');
  expect(reply).not.toHaveBeenCalled();
});

test('delivers the approved text once with mention parsing disabled and propagates transport failure', async () => {
  const sent = { id: 'delivered-message' };
  const reply = mock(async () => sent);
  const transport = { reply } as unknown as Pick<Message, 'reply'>;
  expect((await deliverAssistantReply(transport, 'Approved reply')).id).toBe(sent.id);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenCalledWith({
    content: 'Approved reply',
    files: [],
    allowedMentions: { repliedUser: false, parse: [] }
  });
  const rejected = {
    reply: mock(async () => {
      throw new Error('delivery failed');
    })
  } as unknown as Pick<Message, 'reply'>;
  await expect(deliverAssistantReply(rejected, 'Approved reply')).rejects.toThrow(
    'delivery failed'
  );
  expect(rejected.reply).toHaveBeenCalledTimes(1);
});
