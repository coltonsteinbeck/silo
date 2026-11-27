import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  PatchNotesService,
  buildPatchNotesEmbed,
  encryptPatchNotesToken,
  decryptPatchNotesToken
} from '../../services/patch-notes';
import { AdminAdapter, PatchNotesWebhook } from '../../database/admin-adapter';

type FetchOptions = NonNullable<Parameters<typeof fetch>[1]>;

const fixtureId = (suffix: string) => '1'.padEnd(16, '0') + suffix;
const guildId = fixtureId('01'),
  channelId = fixtureId('02');
const webhookId = fixtureId('03'),
  userId = fixtureId('04'),
  botId = fixtureId('05');
const token = 'opaque_test_webhook_token_1234567890';
const key = Buffer.alloc(32, 7).toString('base64');
const originalFetch = globalThis.fetch;
const releaseDate = new Date('2026-11-15T18:30:00.000Z');
const record = (): PatchNotesWebhook => ({
  guildId,
  channelId,
  webhookId,
  createdBy: userId,
  encryptedToken: ''
});
const hook = () => ({
  id: webhookId,
  guild_id: guildId,
  channel_id: channelId,
  type: 1,
  token,
  name: 'Silo Patch Notes',
  user: { id: botId }
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

describe('patch-note credentials and delivery', () => {
  let stored: PatchNotesWebhook | null;
  let attempts: Set<string>;
  let db: any;
  let service: PatchNotesService;
  let transport: ReturnType<typeof mock>;
  beforeEach(() => {
    stored = null;
    attempts = new Set();
    db = {
      configurePatchNotesWebhook: mock(
        async (_guild: string, create: () => Promise<PatchNotesWebhook>) =>
          stored ?? (stored = await create())
      ),
      getPatchNotesWebhook: mock(async () => stored),
      claimPatchNotesDelivery: mock(async (_guild: string, version: string) => {
        if (attempts.has(version)) return false;
        attempts.add(version);
        return true;
      }),
      completePatchNotesDelivery: mock(async () => {})
    };
    service = new PatchNotesService(
      db,
      { id: botId, token: 'test-bot-token' },
      key,
      () => releaseDate
    );
    transport = mock(async () => json(hook()));
    globalThis.fetch = transport as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('encrypts with fresh nonces and binds ciphertext to all destination identifiers', () => {
    const first = record();
    first.encryptedToken = encryptPatchNotesToken(token, first, key);
    const second = record();
    second.encryptedToken = encryptPatchNotesToken(token, second, key);
    expect(first.encryptedToken).not.toContain(token);
    expect(first.encryptedToken).not.toBe(second.encryptedToken);
    expect(decryptPatchNotesToken(first, key)).toBe(token);
    for (const field of ['guildId', 'channelId', 'webhookId'] as const) {
      expect(() => decryptPatchNotesToken({ ...first, [field]: fixtureId('99') }, key)).toThrow();
    }
    expect(() => decryptPatchNotesToken(first, randomBytes(32).toString('base64'))).toThrow();
    expect(() =>
      decryptPatchNotesToken({ ...first, encryptedToken: first.encryptedToken + 'AAAA' }, key)
    ).toThrow();
  });

  test('missing and invalid keys fail before network or persistence', () => {
    for (const invalid of ['', 'not-a-key', Buffer.alloc(31).toString('base64')]) {
      expect(() => new PatchNotesService(db, { id: botId, token: 'x' }, invalid)).toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
    expect(db.configurePatchNotesWebhook).not.toHaveBeenCalled();
  });

  test('creates once, stores only encrypted credentials, and preserves an existing destination', async () => {
    transport.mockImplementation(async (_url: string, init: FetchOptions) =>
      json(init?.method === 'POST' ? hook() : [])
    );
    const first = await service.setup(guildId, channelId, userId);
    const again = await service.setup(guildId, fixtureId('99'), userId);
    expect(again).toEqual(first);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(first.encryptedToken).not.toContain(token);
    expect(decryptPatchNotesToken(first, key)).toBe(token);
  });

  test('adopts a verified bot-owned hook after an uncertain creation without another POST', async () => {
    transport.mockImplementation(async () => json([hook()]));
    await service.setup(guildId, channelId, userId);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]).not.toHaveProperty('method', 'POST');
  });

  test('database failure leaves a newly created hook intact for reconciliation', async () => {
    transport.mockImplementation(async (_url: string, init: FetchOptions) =>
      json(init?.method === 'POST' ? hook() : [])
    );
    db.configurePatchNotesWebhook.mockImplementation(
      async (_guild: string, create: () => Promise<PatchNotesWebhook>) => {
        await create();
        throw new Error(token);
      }
    );
    await expect(service.setup(guildId, channelId, userId)).rejects.toThrow(
      'Patch-note setup failed.'
    );
    expect(transport.mock.calls.some(call => (call[1] as FetchOptions).method === 'DELETE')).toBe(
      false
    );
  });

  test('never adopts other owners and blocks ambiguous duplicate owned hooks', async () => {
    transport.mockImplementation(async () => json([hook(), hook()]));
    await expect(service.setup(guildId, channelId, userId)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockClear();
    transport.mockImplementation(async (_url: string, init: FetchOptions) =>
      json(init?.method === 'POST' ? hook() : [{ ...hook(), user: { id: userId } }])
    );
    await service.setup(guildId, channelId, userId);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('rejects a wrong-guild setup response and does not persist credentials', async () => {
    transport.mockImplementation(async () => json([{ ...hook(), guild_id: fixtureId('99') }]));
    await expect(service.setup(guildId, channelId, userId)).rejects.toThrow();
    expect(stored).toBeNull();
  });

  const configure = () => {
    stored = record();
    stored.encryptedToken = encryptPatchNotesToken(token, stored, key);
  };
  test('confirms recipient, claims normalized version, disables mentions, and records the real receipt', async () => {
    configure();
    transport.mockImplementation(async (_url: string, init: FetchOptions) =>
      json(
        init?.method === 'POST'
          ? { id: fixtureId('06'), channel_id: channelId, webhook_id: webhookId }
          : hook()
      )
    );
    expect(await service.send(guildId, userId, 'v1.2.3', '@everyone Fix @here <@123>')).toBe(
      'delivered'
    );
    const post = transport.mock.calls.find(call => (call[1] as FetchOptions).method === 'POST')!;
    expect(post[0]).toEndWith('?wait=true');
    const body = JSON.parse((post[1] as FetchOptions).body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toBeUndefined();
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe('Silo v1.2.3 is live');
    expect(body.embeds[0].description).not.toContain('@everyone');
    expect(body.embeds[0].description).not.toContain('@here');
    expect(body.embeds[0].footer.text).toContain('Production • Silo v1.2.3');
    expect(db.completePatchNotesDelivery).toHaveBeenCalledWith(guildId, '1.2.3', fixtureId('06'));
    expect(await service.send(guildId, userId, '1.2.3', 'Different notes')).toBe(
      'already-attempted'
    );
    expect(
      transport.mock.calls.filter(call => (call[1] as FetchOptions).method === 'POST')
    ).toHaveLength(1);
  });

  test('footer time does not change the durable duplicate claim', async () => {
    configure();
    let now = releaseDate;
    service = new PatchNotesService(db, { id: botId, token: 'test-bot-token' }, key, () => now);
    transport.mockImplementation(async (_url: string, init: FetchOptions) =>
      json(
        init?.method === 'POST'
          ? { id: fixtureId('06'), channel_id: channelId, webhook_id: webhookId }
          : hook()
      )
    );
    expect(await service.send(guildId, userId, '2.1.0', 'Added\n- Use /search')).toBe('delivered');
    now = new Date('2026-11-16T18:30:00.000Z');
    expect(await service.send(guildId, userId, 'v2.1.0', 'Added\n- Use /search')).toBe(
      'already-attempted'
    );
    expect(db.claimPatchNotesDelivery.mock.calls[0]![2]).toBe(
      db.claimPatchNotesDelivery.mock.calls[1]![2]
    );
    expect(
      transport.mock.calls.filter(call => (call[1] as FetchOptions).method === 'POST')
    ).toHaveLength(1);
  });

  test.each(['guild_id', 'channel_id', 'id'] as const)(
    'wrong recipient %s blocks before claim and POST',
    async field => {
      configure();
      transport.mockImplementation(async () => json({ ...hook(), [field]: fixtureId('99') }));
      await expect(service.send(guildId, userId, '1.2.3', 'Notes')).rejects.toThrow(
        'destination changed'
      );
      expect(db.claimPatchNotesDelivery).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(1);
    }
  );

  test('an ambiguous send keeps its durable claim and never automatically repeats', async () => {
    configure();
    transport.mockImplementation(async (_url: string, init: FetchOptions) => {
      if (init?.method === 'POST')
        throw new Error(`https://discord.com/api/v10/webhooks/${webhookId}/${token}`);
      return json(hook());
    });
    await expect(service.send(guildId, userId, '1.2.3', 'Notes')).rejects.toThrow(
      'Patch-note Discord request failed.'
    );
    expect(await service.send(guildId, userId, 'v1.2.3', 'Notes')).toBe('already-attempted');
    expect(
      transport.mock.calls.filter(call => (call[1] as FetchOptions).method === 'POST')
    ).toHaveLength(1);
    expect(db.completePatchNotesDelivery).not.toHaveBeenCalled();
  });

  test('receipt persistence failure also prevents a repeat send', async () => {
    configure();
    db.completePatchNotesDelivery.mockImplementation(async () => {
      throw new Error('Database unavailable');
    });
    transport.mockImplementation(async (_url: string, init: FetchOptions) =>
      json(
        init?.method === 'POST'
          ? { id: fixtureId('06'), channel_id: channelId, webhook_id: webhookId }
          : hook()
      )
    );
    await expect(service.send(guildId, userId, '1.2.3', 'Notes')).rejects.toThrow();
    expect(await service.send(guildId, userId, '1.2.3', 'Notes')).toBe('already-attempted');
    expect(
      transport.mock.calls.filter(call => (call[1] as FetchOptions).method === 'POST')
    ).toHaveLength(1);
  });

  test('wrong message receipt never marks delivery complete', async () => {
    configure();
    transport.mockImplementation(async (_url: string, init: FetchOptions) =>
      json(
        init?.method === 'POST'
          ? { id: fixtureId('06'), channel_id: fixtureId('99'), webhook_id: webhookId }
          : hook()
      )
    );
    await expect(service.send(guildId, userId, '1.2.3', 'Notes')).rejects.toThrow('receipt');
    expect(db.completePatchNotesDelivery).not.toHaveBeenCalled();
  });

  test('invalid content, missing setup, or unreadable credentials cause no network request', async () => {
    await expect(service.send(guildId, userId, 'invalid', 'Notes')).rejects.toThrow();
    await expect(service.send(guildId, userId, 'vv1.2.3', 'Notes')).rejects.toThrow();
    await expect(service.send(guildId, userId, '1.2.3', ' ')).rejects.toThrow();
    await expect(service.send(guildId, userId, '1.2.3', 'Added\nFixed')).rejects.toThrow();
    await expect(service.send(guildId, userId, '1.2.3', 'x'.repeat(1801))).rejects.toThrow();
    await expect(
      service.send(
        guildId,
        userId,
        '1.2.3',
        `Added\n${Array.from({ length: 598 }, () => '/a').join('\n')}`
      )
    ).rejects.toThrow('embed limits');
    await expect(service.send(guildId, userId, '1.2.3', 'Notes')).rejects.toThrow('Set up');
    configure();
    stored!.encryptedToken = 'bad';
    await expect(service.send(guildId, userId, '1.2.3', 'Notes')).rejects.toThrow('unlocked');
    expect(transport).not.toHaveBeenCalled();
    expect(db.claimPatchNotesDelivery).not.toHaveBeenCalled();
  });

  test('transport redirects and HTTP errors are sanitized without retry', async () => {
    configure();
    transport.mockImplementation(async () => new Response(token, { status: 500 }));
    await expect(service.send(guildId, userId, '1.2.3', 'Notes')).rejects.toThrow(
      'Patch-note Discord request failed.'
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]).toHaveProperty('redirect', 'error');
    expect(transport.mock.calls[0]![1]).toHaveProperty('signal');
  });
});

describe('patch-note release card', () => {
  test('groups nonempty sections and formats slash commands without dropping introductory text', () => {
    const embed = buildPatchNotesEmbed(
      'v2.1.0',
      'A short introduction.\n\nAdded\n- Use /search for sources\n- Try `/draw`\nChanged:\n* Better replies\nFixed\n',
      releaseDate
    );
    expect(embed.title).toBe('Silo v2.1.0 is live');
    expect(embed.color).toBe(0x5865f2);
    expect(embed.description).toBe(
      '**Notes**\nA short introduction.\n\n**Added**\n• Use `/search` for sources\n• Try `/draw`\n\n**Changed**\n• Better replies'
    );
    expect(embed.footer.text).toContain('Nov 15, 2026');
    expect(embed.footer.text).toContain('EST');
  });

  test('keeps free-text submissions readable and prevents mass mentions', () => {
    const embed = buildPatchNotesEmbed(
      '2.1.0',
      'Improved /draw.\n@everyone please try it.',
      releaseDate
    );
    expect(embed.description).toStartWith('**Notes**\n');
    expect(embed.description).toContain('`/draw`');
    expect(embed.description).not.toContain('@everyone');
    expect(buildPatchNotesEmbed('2.1.0', '- Existing bullet', releaseDate).description).toContain(
      '- Existing bullet'
    );
  });

  test('rejects expanded content beyond Discord limits before delivery', () => {
    const manyLines = Array.from({ length: 598 }, () => '/a').join('\n');
    expect(() => buildPatchNotesEmbed('2.1.0', `Added\n${manyLines}`, releaseDate)).toThrow(
      'embed limits'
    );
    expect(() => buildPatchNotesEmbed('2.1.0', 'x'.repeat(1801), releaseDate)).toThrow('1–1800');
  });
});

describe('AdminAdapter patch-note transactions', () => {
  test('a busy setup lock performs no external create and always releases its connection', async () => {
    const client = {
      query: mock(async (sql: string) => ({
        rows: sql.includes('pg_try_advisory') ? [{ acquired: false }] : []
      })),
      release: mock(() => {})
    };
    const adapter = new AdminAdapter({ connect: async () => client } as any),
      create = mock(async () => record());
    await expect(adapter.configurePatchNotesWebhook(guildId, create)).rejects.toThrow(
      'already running'
    );
    expect(create).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
