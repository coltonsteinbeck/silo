import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { GuildMember } from 'discord.js';
import { DrawCommand } from '../../commands/draw';
import { VideoCommand } from '../../commands/video';
import * as delivery from '../../services/media-delivery';

beforeEach(() => {
  spyOn(delivery, 'buildMediaReplyPayload').mockResolvedValue({ uploaded: true, files: [] });
});
afterEach(() => mock.restore());
function setup(kind: 'draw' | 'video') {
  const controller = new AbortController();
  const generate = mock(async (_prompt: string, _options?: any) => ({
    url: 'https://example.com/media',
    model: 'media-model'
  }));
  const registry = {
    getImageProvider: () => ({ name: 'openai', generateImage: generate }),
    getConfiguredImageModel: () => 'gpt-image-1',
    getVideoProvider: () => ({ name: 'xai', generateVideo: generate }),
    getConfiguredVideoModel: () => 'grok-imagine-video'
  };
  const quota = {
    executeReserved: mock(async (p: any) => {
      await p.beforeAttempt();
      const value = await p.execute(p.requestedAmount);
      return { allowed: true, value };
    }),
    checkQuota: mock(async () => ({ allowed: true })),
    recordUsage: mock(async () => {})
  };
  const user = { id: 'user', username: 'tester' };
  const interaction: any = {
    id: 'interaction',
    guildId: 'guild',
    channelId: 'channel',
    user,
    member: Object.assign(Object.create(GuildMember.prototype), { user, guild: { id: 'guild' } }),
    options: {
      getString: (name: string) => (name === 'prompt' ? 'A paper bird' : null),
      getInteger: () => 5,
      getAttachment: () => null
    },
    deferReply: mock(async () => {}),
    editReply: mock(async () => ({ id: 'message' })),
    reply: mock(async () => {}),
    followUp: mock(async () => {}),
    deferUpdate: mock(async () => {}),
    message: { edit: mock(async () => {}) },
    channel: { messages: { fetch: mock(async () => ({ edit: mock(async () => {}) })) } },
    fields: { getTextInputValue: () => 'A blue paper bird' }
  };
  const guard = mock(async () => ({ allowed: true, processedPrompt: 'A paper bird' }));
  const command =
    kind === 'draw'
      ? new DrawCommand(registry as any, quota as any, undefined, guard, controller.signal)
      : new VideoCommand(registry as any, quota as any, undefined, guard, controller.signal);
  return { command, interaction, quota, controller, generate, guard };
}
for (const kind of ['draw', 'video'] as const) {
  test(`${kind} reports a provider deadline instead of leaving a deferred reply pending`, async () => {
    const deadline = new AbortController();
    spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const f = setup(kind);
    f.generate.mockImplementation(async () => {
      deadline.abort(new globalThis.DOMException('Deadline reached', 'TimeoutError'));
      throw deadline.signal.reason;
    });
    await f.command.execute(f.interaction);
    expect(f.interaction.editReply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.interaction.editReply.mock.calls)).toContain('timed out');
    expect(f.quota.executeReserved).toHaveBeenCalledTimes(1);
  });
  test(`${kind} reserves once before generation and never increments legacy usage`, async () => {
    const f = setup(kind);
    await f.command.execute(f.interaction);
    expect(f.quota.executeReserved).toHaveBeenCalledTimes(1);
    expect(f.quota.executeReserved.mock.calls[0]?.[0]).toMatchObject({
      operationKey: 'discord:interaction:media',
      guildId: 'guild',
      userId: 'user',
      usageType: kind === 'draw' ? 'images' : 'video_tokens'
    });
    expect(f.generate.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(f.quota.recordUsage).not.toHaveBeenCalled();
  });
  test(`${kind} rejects quota denial and untrusted member identity before provider`, async () => {
    const f = setup(kind);
    f.quota.executeReserved.mockImplementation(
      async () => ({ allowed: false, reason: 'Daily quota reached' }) as any
    );
    await f.command.execute(f.interaction);
    expect(f.generate).not.toHaveBeenCalled();
    const g = setup(kind);
    g.interaction.member = { id: 'user', guild: { id: 'guild' } };
    await g.command.execute(g.interaction);
    expect(g.generate).not.toHaveBeenCalled();
  });
  test(`${kind} cancels before a reserved attempt and suppresses late result delivery`, async () => {
    const f = setup(kind);
    f.quota.executeReserved.mockImplementation(async (p: any) => {
      f.controller.abort();
      await p.beforeAttempt();
      return { allowed: true, value: await p.execute() };
    });
    await f.command.execute(f.interaction);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.interaction.editReply).not.toHaveBeenCalled();
    const g = setup(kind);
    g.generate.mockImplementation(async () => {
      g.controller.abort();
      return { url: 'https://example.com/media', model: 'media-model' };
    });
    await g.command.execute(g.interaction);
    expect(g.interaction.editReply).not.toHaveBeenCalled();
  });
}
for (const action of ['regen', 'modal'] as const) {
  test(`draw ${action} also uses atomic quota and suppresses cancelled output`, async () => {
    const f = setup('draw');
    await f.command.execute(f.interaction);
    const id = [...(f.command as any).sessions.keys()][0];
    f.interaction.id = 'control';
    f.interaction.customId = `draw_${action}:${id}`;
    f.generate.mockImplementation(async () => {
      f.controller.abort();
      return { url: 'https://example.com/media', model: 'media-model' };
    });
    f.interaction.editReply.mockClear();
    if (action === 'regen') await (f.command as DrawCommand).handleButtonInteraction(f.interaction);
    else await (f.command as DrawCommand).handleModalSubmit(f.interaction);
    expect(f.quota.executeReserved).toHaveBeenCalledTimes(2);
    expect(f.interaction.message.edit).not.toHaveBeenCalled();
    expect(f.interaction.channel.messages.fetch).not.toHaveBeenCalled();
    expect(f.interaction.editReply).not.toHaveBeenCalled();
  });
}

test('draw edit never reports success when original message update fails', async () => {
  const f = setup('draw');
  await f.command.execute(f.interaction);
  const id = [...(f.command as any).sessions.keys()][0];
  f.interaction.id = 'edit';
  f.interaction.customId = `draw_modal:${id}`;
  f.interaction.channel.messages.fetch.mockRejectedValue(new Error('Message unavailable'));
  f.interaction.editReply.mockClear();
  await (f.command as DrawCommand).handleModalSubmit(f.interaction);
  expect(JSON.stringify(f.interaction.editReply.mock.calls)).not.toContain(
    'Image updated successfully'
  );
  expect(JSON.stringify(f.interaction.editReply.mock.calls)).toContain('Image edit failed');
});

for (const kind of ['draw', 'video'] as const) {
  test(`${kind} does not make a provider call for a duplicate interaction reservation`, async () => {
    const f = setup(kind);
    let admitted = false;
    f.quota.executeReserved.mockImplementation(async (p: any) => {
      if (admitted) return { allowed: false, reason: 'Already handled' } as any;
      admitted = true;
      await p.beforeAttempt();
      return { allowed: true, value: await p.execute(p.requestedAmount) };
    });
    await Promise.all([f.command.execute(f.interaction), f.command.execute(f.interaction)]);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  test(`${kind} cancellation during download suppresses delivery after quota settlement`, async () => {
    const f = setup(kind);
    spyOn(delivery, 'buildMediaReplyPayload').mockImplementation(async () => {
      f.controller.abort();
      return { uploaded: true, files: [] };
    });
    await f.command.execute(f.interaction);
    expect(f.quota.executeReserved).toHaveBeenCalledTimes(1);
    expect(f.interaction.editReply).not.toHaveBeenCalled();
  });
}
