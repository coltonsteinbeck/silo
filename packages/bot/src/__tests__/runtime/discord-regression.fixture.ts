import { strict as assert } from 'node:assert';
import type { EventEmitter } from 'node:events';
import { access } from 'node:fs/promises';
import type * as Discord from 'discord.js';

export function syntheticDiscordId(sequence: number): string {
  return (10n ** 17n + BigInt(sequence)).toString();
}

type Replies = Array<{ content?: string; flags?: number; allowedMentions?: unknown }>;

export async function runDiscordRegression({
  discord,
  SdkClient,
  appClient,
  appId,
  guildId,
  calls,
  claims,
  persisted,
  modelInputs,
  commandWrites,
  searchEnabled,
  disableModeration
}: {
  discord: typeof Discord;
  SdkClient: typeof Discord.Client;
  appClient: EventEmitter;
  appId: string;
  guildId: string;
  calls: string[];
  claims: Set<string>;
  persisted: unknown[];
  modelInputs: unknown[];
  commandWrites: Array<{ route: string; body: Array<{ name: string; type: number }> }>;
  searchEnabled: boolean;
  disableModeration: () => void;
}) {
  const suites = {
    admin: ['admin', 'admin-patch-notes'],
    analytics: ['analytics'],
    config: ['config'],
    digest: ['digest'],
    draw: ['draw'],
    feedback: ['feedback'],
    help: ['help'],
    'memory-clear': ['memory'],
    'memory-view': ['memory'],
    mod: ['mod'],
    radio: ['radio'],
    search: ['search'],
    'server-memory-set': ['memory'],
    speak: ['speak'],
    stopspeaking: ['stopspeaking'],
    thread: ['thread'],
    'user-memory-set': ['memory', 'user-memory-set.sentiment'],
    video: ['video']
  };
  assert.equal(commandWrites.length, 1, 'expected one test-guild registration and no global write');
  const write = commandWrites[0];
  assert(write);
  assert.equal(write.route, discord.Routes.applicationGuildCommands(appId, guildId));
  const expected = Object.keys(suites).filter(name => searchEnabled || name !== 'search');
  assert.deepEqual(write.body.map(command => command.name).sort(), expected.sort());
  assert(write.body.every(command => command.type === discord.ApplicationCommandType.ChatInput));
  for (const file of new Set(Object.values(suites).flat())) {
    await access(new URL(`../commands/${file}.test.ts`, import.meta.url));
  }

  assert.deepEqual(
    appClient.eventNames().sort(),
    [
      discord.Events.Error,
      discord.Events.GuildCreate,
      discord.Events.GuildDelete,
      discord.Events.InteractionCreate,
      discord.Events.MessageCreate,
      discord.Events.MessageReactionAdd,
      discord.Events.VoiceStateUpdate
    ].sort(),
    'update the regression scenarios when the running app changes its Discord listeners'
  );

  const [onInteraction] = appClient.listeners(discord.Events.InteractionCreate);
  const [onMessage] = appClient.listeners(discord.Events.MessageCreate);
  assert(onInteraction && onMessage, 'production Discord listeners must be registered');
  const channelId = syntheticDiscordId(3);
  const memberId = syntheticDiscordId(4);
  const adminId = syntheticDiscordId(5);
  const aliceId = syntheticDiscordId(6);

  for (const [userId, isAdmin] of [
    [memberId, false],
    [adminId, true]
  ] as const) {
    const member = Object.create(discord.GuildMember.prototype);
    Object.defineProperty(member, 'permissions', {
      value: new discord.PermissionsBitField(
        isAdmin ? discord.PermissionFlagsBits.Administrator : 0n
      )
    });
    const replies: Replies = [];
    const deferred: Replies = [];
    await onInteraction({
      id: userId,
      guildId,
      channelId,
      user: { id: userId },
      member,
      commandName: 'admin',
      options: { getSubcommand: () => 'patch-notes-status' },
      isChatInputCommand: () => true,
      isModalSubmit: () => false,
      isButton: () => false,
      reply: async (payload: Replies[number]) => replies.push(payload),
      deferReply: async (payload: Replies[number]) => deferred.push(payload),
      editReply: async (payload: Replies[number]) => replies.push(payload)
    });
    const ephemeral = { flags: discord.MessageFlags.Ephemeral };
    if (isAdmin) {
      assert.deepEqual(deferred, [ephemeral]);
      assert.deepEqual(replies, [
        { content: 'No patch-note webhook configured.', allowedMentions: { parse: [] } }
      ]);
    } else {
      assert.deepEqual(deferred, []);
      assert.deepEqual(replies, [
        { ...ephemeral, content: 'You need admin permissions to use this command.' }
      ]);
    }
  }
  assert.equal(calls.filter(call => call === 'patch-notes-status-read').length, 1);

  const helpReplies: Array<Replies[number] & { ephemeral?: boolean }> = [];
  await onInteraction({
    id: syntheticDiscordId(11),
    guildId,
    channelId,
    user: { id: memberId },
    commandName: 'help',
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    isButton: () => false,
    reply: async (payload: (typeof helpReplies)[number]) => helpReplies.push(payload)
  });
  assert.equal(helpReplies.length, 1);
  assert(helpReplies[0]?.ephemeral);
  assert.equal(helpReplies[0].content?.includes('/search -'), searchEnabled);

  const sdk = new SdkClient({
    intents: [discord.GatewayIntentBits.Guilds, discord.GatewayIntentBits.GuildMessages]
  });
  try {
    const bot = { id: appId, username: 'FixtureBot', discriminator: '0000', bot: true };
    const alice = { id: aliceId, username: 'Alice', discriminator: '0000', bot: false };
    const speaker = { id: memberId, username: 'Speaker', discriminator: '0000', bot: false };
    Reflect.set(sdk, 'user', Reflect.get(sdk.users, '_add').call(sdk.users, bot));
    const guild = Reflect.get(sdk.guilds, '_add').call(sdk.guilds, {
      id: guildId,
      name: 'Fixture Guild'
    });
    for (const user of [speaker, alice]) {
      Reflect.get(guild.members, '_add').call(guild.members, { user, roles: [] });
    }
    Reflect.get(sdk.channels, '_add').call(
      sdk.channels,
      { id: channelId, guild_id: guildId, name: 'fixture', type: discord.ChannelType.GuildText },
      guild
    );
    const sdkIngress = Reflect.get(sdk, 'actions').MessageCreate;
    const responses: Replies = [];
    const events: Discord.Message[] = [];
    const pending: Promise<unknown>[] = [];
    sdk.on(discord.Events.MessageCreate, message => {
      events.push(message);
      Object.defineProperty(message, 'reply', {
        value: async (reply: Replies[number]) => {
          responses.push(reply);
          return { id: 'fixture-reply', createdTimestamp: message.createdTimestamp };
        }
      });
      Object.defineProperty(message.channel, 'sendTyping', {
        configurable: true,
        value: async () => {}
      });
      pending.push(onMessage(message));
    });
    const packet = {
      id: syntheticDiscordId(7),
      guild_id: guildId,
      channel_id: channelId,
      type: 0,
      content: `<@${appId}> Explain how a bicycle chain works to <@${aliceId}>.`,
      author: speaker,
      mentions: [bot, alice],
      mention_roles: [],
      attachments: [],
      embeds: [],
      timestamp: '2026-01-01T00:00:00.000Z',
      edited_timestamp: null,
      pinned: false,
      tts: false,
      mention_everyone: false
    };
    sdkIngress.handle(packet);
    sdkIngress.handle(packet);
    await Promise.all(pending);
    assert.equal(events.length, 1, 'Discord.js must hydrate a replayed packet only once');
    const firstEvent = events[0];
    assert(firstEvent);
    await onMessage(firstEvent);
    assert.equal(claims.size, 1);
    assert.equal(modelInputs.length, 1, 'app admission must prevent duplicate generation');
    assert.match(JSON.stringify(modelInputs[0]), /Alice/);
    assert(
      !JSON.stringify(modelInputs[0]).includes(aliceId),
      'a Discord ID leaked into model text'
    );
    assert.equal(responses.length, 1);
    const firstResponse = responses[0];
    assert(firstResponse);
    assert.deepEqual(firstResponse.allowedMentions, { repliedUser: false, parse: [] });
    assert.equal(firstResponse.content, 'The chain transfers power.');
    assert.equal(persisted.length, 1, 'app admission must prevent duplicate writes');

    await onMessage({ ...firstEvent, id: syntheticDiscordId(8), guildId: 'other-guild' });
    assert.equal(claims.size, 1, 'an out-of-scope guild must not claim or read state');

    sdkIngress.handle({
      ...packet,
      id: syntheticDiscordId(9),
      author: alice,
      content: `<@${appId}> Describe how a bell works.`,
      mentions: [bot]
    });
    await Promise.all(pending);
    assert.equal(modelInputs.length, 2, 'a distinct member and event must be processed');
    assert.match(JSON.stringify(modelInputs[1]), /Describe how a bell works/);
    assert(!JSON.stringify(modelInputs[1]).includes('Explain how a bicycle chain works'));
    assert.equal(responses.length, 2);
    assert.equal(persisted.length, 2);

    disableModeration();
    sdkIngress.handle({ ...packet, id: syntheticDiscordId(10) });
    await Promise.all(pending);
    assert.equal(modelInputs.length, 2, 'safety outage must prevent generation');
    assert.equal(responses.length, 3, 'safety outage must return one controlled reply');
    const outageResponse = responses[2];
    assert(outageResponse);
    assert.notEqual(outageResponse.content, 'The chain transfers power.');
    assert.deepEqual(outageResponse.allowedMentions, { repliedUser: false, parse: [] });
  } finally {
    await sdk.destroy();
  }
  process.stdout.write('offline-discord-regression-passed\n');
}
