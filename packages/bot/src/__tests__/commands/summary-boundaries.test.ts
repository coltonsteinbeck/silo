import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Collection, GuildMember } from 'discord.js';
import { ThreadCommand } from '../../commands/thread';
import { DigestCommand } from '../../commands/digest';
import { hashPrompt } from '../../security/prompt-policy';
import * as safety from '../../security/safety-decision';

let evaluate: ReturnType<typeof spyOn>;
beforeEach(() => {
  evaluate = spyOn(safety, 'evaluateSafetyDecision').mockResolvedValue({
    action: 'allow',
    failed: false
  } as any);
});
afterEach(() => mock.restore());

function setup(kind: 'thread' | 'digest', withQuota = true) {
  const controller = new AbortController();
  const generateText = mock(async () => ({ content: 'A safe summary', model: 'test-model' }));
  const registry = {
    getTextRoute: mock(() => ({
      provider: { name: 'openai', capabilities: {}, generateText },
      options: { model: 'test-model', reasoning: { effort: 'none' } }
    }))
  };
  const db = {
    getPromptContext: mock(async (_query?: any) => ({
      messages: [{ role: 'user', content: 'A safe topic' }]
    })),
    getConversationHistory: mock(async () => [
      { role: 'user', content: 'Ineligible legacy history' }
    ])
  };
  const createThread = mock(async () => ({
    toString: (): string => '<#thread>',
    send: mock(async () => {})
  }));
  const channel = {
    id: 'channel',
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: mock(
        async () =>
          new Collection([
            [
              'message',
              {
                content: 'A safe topic',
                author: { id: 'user', username: 'tester', bot: false },
                createdAt: new Date()
              }
            ]
          ])
      )
    },
    threads: { create: createThread }
  };
  const guild = { id: 'guild', channels: { cache: new Collection([['channel', channel]]) } };
  const user = { id: 'user', username: 'tester' };
  const member = Object.assign(Object.create(GuildMember.prototype), { user, guild });
  const interaction = {
    id: 'interaction',
    guildId: guild.id,
    channelId: channel.id,
    guild,
    channel,
    user,
    member,
    options: { getString: () => null, getBoolean: () => false },
    deferReply: mock(async () => {}),
    editReply: mock(async (_value: any) => {})
  };
  const quota = withQuota ? {} : undefined;
  const command =
    kind === 'thread'
      ? new ThreadCommand(db as any, registry as any, quota as any, controller.signal, async () =>
          hashPrompt('Current safe prompt')
        )
      : new DigestCommand(registry as any, quota as any, controller.signal);
  return { command, interaction, quota, db, registry, generateText, createThread, controller };
}

for (const kind of ['thread', 'digest'] as const) {
  test(`${kind} binds paid summary attempts to trusted quota identity and checks exact delivery text`, async () => {
    const f = setup(kind);
    await f.command.execute(f.interaction as any);
    expect(f.registry.getTextRoute).toHaveBeenCalledWith('summary', undefined, {
      middleware: f.quota,
      operationKey: `discord:interaction:${kind}`,
      guildId: 'guild',
      userId: 'user',
      member: f.interaction.member,
      usageType: 'text_tokens'
    });
    expect(evaluate).toHaveBeenCalledWith(
      'A safe summary',
      expect.objectContaining({
        stage: 'assistant_output',
        failurePolicy: 'fail_closed',
        signal: expect.any(AbortSignal)
      })
    );
    expect(f.generateText).toHaveBeenCalledTimes(1);
    if (kind === 'thread') {
      expect(f.db.getConversationHistory).not.toHaveBeenCalled();
      expect(f.db.getPromptContext).toHaveBeenCalledWith(
        expect.objectContaining({
          guildId: 'guild',
          channelId: 'channel',
          requesterUserId: 'user',
          maxTurns: 5
        })
      );
    }
  });

  test.each([
    { action: 'block', failed: false },
    { action: 'allow', failed: true }
  ])(`${kind} never publishes a rejected or unverified summary`, async decision => {
    evaluate.mockResolvedValue(decision as any);
    const f = setup(kind);
    await f.command.execute(f.interaction as any);
    expect(f.generateText).toHaveBeenCalledTimes(1);
    expect(f.createThread).not.toHaveBeenCalled();
    expect(JSON.stringify(f.interaction.editReply.mock.calls)).not.toContain('A safe summary');
    expect(
      f.interaction.editReply.mock.calls.some(
        ([value]) => typeof value === 'string' && /safely|temporarily unavailable/.test(value)
      )
    ).toBe(true);
  });

  test(`${kind} evaluates the exact bounded text delivered to Discord`, async () => {
    const f = setup(kind);
    const raw = '@everyone ' + 'safe text '.repeat(600);
    f.generateText.mockResolvedValue({ content: raw, model: 'test-model' });
    await f.command.execute(f.interaction as any);
    const expected = ('everyone ' + 'safe text '.repeat(600))
      .trim()
      .slice(0, kind === 'thread' ? 100 : 4096);
    expect(evaluate.mock.calls[0]?.[0]).toBe(expected);
    if (kind === 'thread') expect((f.createThread.mock.calls[0] as any)?.[0].name).toBe(expected);
    else
      expect(f.interaction.editReply.mock.calls.at(-1)?.[0].embeds[0].data.description).toBe(
        expected
      );
  });

  test(`${kind} cannot call a provider without quota admission`, async () => {
    const f = setup(kind, false);
    await expect(f.command.execute(f.interaction as any)).rejects.toThrow('quota admission');
    expect(f.generateText).not.toHaveBeenCalled();
  });

  test(`${kind} rejects a mismatched guild member before provider access`, async () => {
    const f = setup(kind);
    f.interaction.member.guild = { id: 'other-guild' };
    await expect(f.command.execute(f.interaction as any)).rejects.toThrow('quota admission');
    expect(f.generateText).not.toHaveBeenCalled();
  });

  test(`${kind} discards a generation that finishes after cancellation`, async () => {
    const f = setup(kind);
    f.generateText.mockImplementation(async () => {
      f.controller.abort(new Error('cancelled summary'));
      return { content: 'Late summary', model: 'test-model' };
    });
    await expect(f.command.execute(f.interaction as any)).rejects.toThrow('cancelled summary');
    expect(f.createThread).not.toHaveBeenCalled();
    expect(f.interaction.editReply).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
}

test('thread uses the active hashed partition and excludes mismatched context', async () => {
  const f = setup('thread');
  const activeHash = hashPrompt('Current safe prompt');
  const otherHash = hashPrompt('Retired prompt');
  f.db.getPromptContext.mockImplementation(async (query: any) => ({
    messages: [
      { role: 'user', promptHash: activeHash, content: 'Eligible topic' },
      { role: 'user', promptHash: otherHash, content: 'Excluded topic' }
    ].filter(row => row.promptHash === query.promptHash)
  }));
  await f.command.execute(f.interaction as any);
  expect(f.db.getPromptContext).toHaveBeenCalledWith(
    expect.objectContaining({ promptHash: activeHash })
  );
  expect(f.generateText).toHaveBeenCalledTimes(1);
  const request = JSON.stringify(f.generateText.mock.calls);
  expect(request).toContain('Eligible topic');
  expect(request).not.toContain('Excluded topic');
});

test('thread suppresses completion when cancellation occurs during creation', async () => {
  const f = setup('thread');
  const send = mock(async () => {});
  f.createThread.mockImplementation(async () => {
    f.controller.abort();
    return { toString: () => '<#thread>', send };
  });
  await expect(f.command.execute(f.interaction as any)).rejects.toThrow();
  expect(f.interaction.editReply).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test('thread suppresses welcome when cancellation occurs during completion reply', async () => {
  const f = setup('thread');
  const send = mock(async () => {});
  f.createThread.mockImplementation(async () => ({ toString: () => '<#thread>', send }));
  f.interaction.editReply.mockImplementation(async () => {
    f.controller.abort();
  });
  await expect(f.command.execute(f.interaction as any)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
