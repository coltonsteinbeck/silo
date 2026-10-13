/**
 * Tests for Digest Command
 *
 * Tests conversation digest/summary functionality.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { Collection, PermissionFlagsBits, GuildMember } from 'discord.js';
import { createMockInteraction as createBaseInteraction } from '@silo/core/test-setup';
import { DigestCommand } from '../../commands/digest';
import * as safety from '../../security/safety-decision';

function createMockInteraction(options?: Parameters<typeof createBaseInteraction>[0]) {
  const interaction = createBaseInteraction(options);
  Object.assign(interaction, {
    id: 'interaction',
    member: Object.assign(Object.create(GuildMember.prototype), {
      user: interaction.user,
      guild: { id: interaction.guildId }
    })
  });
  return interaction;
}

describe('DigestCommand', () => {
  let command: DigestCommand;

  let mockRegistry: any;

  afterEach(() => mock.restore());

  beforeEach(() => {
    spyOn(safety, 'evaluateSafetyDecision').mockResolvedValue({
      action: 'allow',
      failed: false
    } as any);
    mockRegistry = {
      getTextProvider: mock(() => ({
        name: 'openai',
        capabilities: {},
        generateText: mock(async () => ({ content: 'Summary text', model: 'test-model' }))
      })),
      getProvider: mock(() => ({
        name: 'openai',
        capabilities: {},
        generateText: mock(async () => ({ content: 'Summary text', model: 'test-model' }))
      })),
      getConfiguredTextModel: mock(() => 'test-model'),
      getTextRoute: mock(() => ({
        provider: mockRegistry.getTextProvider(),
        options: { model: 'test-model', reasoning: { effort: 'none' } }
      })),
      isConfigured: mock(() => true)
    };
    command = new DigestCommand(mockRegistry, {} as any);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('digest');
    });

    test('has correct description', () => {
      expect(command.data.description).toContain('digest');
    });

    test('has period option', () => {
      const json = command.data.toJSON();
      const periodOption = json.options?.find(opt => opt.name === 'period');
      expect(periodOption).toBeDefined();
    });
  });

  describe('execute', () => {
    test.each([false, null])(
      'does not fetch channels the requester cannot read (%s)',
      async access => {
        const generateText = mock(async () => ({
          content: 'Visible summary',
          model: 'test-model'
        }));
        mockRegistry.getTextProvider = mock(() => ({
          name: 'openai',
          capabilities: {},
          generateText
        }));
        const visible = {
          id: 'visible',
          name: 'visible',
          type: 0,
          isTextBased: () => true,
          permissionsFor: mock(() => ({ has: mock(() => true) })),
          messages: {
            fetch: mock(
              async () =>
                new Collection([
                  [
                    'message',
                    {
                      content: 'Visible topic',
                      author: { id: 'author', username: 'author', bot: false },
                      createdAt: new Date()
                    }
                  ]
                ])
            )
          }
        };
        const hidden = {
          ...visible,
          id: 'hidden',
          name: 'Restricted channel',
          permissionsFor: mock(() => (access === null ? null : { has: () => false })),
          messages: {
            fetch: mock(
              async () =>
                new Collection([
                  [
                    'secret',
                    {
                      content: 'Restricted topic',
                      author: { id: 'private-user', username: 'private-user', bot: false },
                      createdAt: new Date()
                    }
                  ]
                ])
            )
          }
        };
        const interaction = createMockInteraction({ options: { include_stats: false } });
        Object.assign(interaction, {
          guild: {
            channels: {
              cache: new Collection<string, typeof visible | typeof hidden>([
                ['visible', visible],
                ['hidden', hidden]
              ])
            }
          }
        });
        await command.execute(interaction as any);
        expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
        expect(hidden.messages.fetch).not.toHaveBeenCalled();
        expect(generateText).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(generateText.mock.calls)).not.toContain('Restricted topic');
        expect(visible.permissionsFor).toHaveBeenCalledWith(interaction.user);
        const payload = interaction._getReplies().at(-1) as any;
        expect(payload.allowedMentions).toEqual({ parse: [] });
        expect(payload.embeds[0].data.description).toBe('Visible summary');
      }
    );

    test.each(['fetch', 'generation'])(
      'discards content if read access is revoked during %s',
      async stage => {
        let allowed = true;
        const has = mock((required: bigint[]) => {
          expect(required).toEqual([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory
          ]);
          return allowed;
        });
        const generateText = mock(async () => {
          if (stage === 'generation') allowed = false;
          return { content: 'Restricted summary', model: 'test-model' };
        });
        mockRegistry.getTextProvider = mock(() => ({
          name: 'openai',
          capabilities: {},
          generateText
        }));
        const channel = {
          id: 'channel',
          type: 0,
          isTextBased: () => true,
          permissionsFor: () => ({ has }),
          messages: {
            fetch: mock(async () => {
              if (stage === 'fetch') allowed = false;
              return new Collection([
                [
                  'message',
                  {
                    content: 'Restricted topic',
                    author: { id: 'author', username: 'author', bot: false },
                    createdAt: new Date()
                  }
                ]
              ]);
            })
          }
        };
        const interaction = createMockInteraction({ options: { include_stats: false } });
        Object.assign(interaction, {
          guild: { channels: { cache: new Collection([['channel', channel]]) } }
        });
        await command.execute(interaction as any);
        expect(generateText).toHaveBeenCalledTimes(stage === 'fetch' ? 0 : 1);
        expect(JSON.stringify(interaction._getReplies())).not.toContain('Restricted');
        expect(interaction._getReplies().at(-1)).toMatch(/No messages|Channel access changed/);
      }
    );

    test('defers reply on execution', async () => {
      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => '1h');
      interaction.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction.channel = { type: 0, messages: { fetch: mock(async () => new Map()) } };

      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('handles no messages in period', async () => {
      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => '1h');
      interaction.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction.channel = { type: 0, messages: { fetch: mock(async () => new Map()) } };

      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('generates digest with messages', async () => {
      const mockMessages = new Map([
        [
          'msg1',
          {
            content: 'Hello',
            author: { bot: false, id: 'user-1', username: 'alice' },
            createdAt: new Date()
          }
        ],
        ['msg2', { content: 'Hi there!', author: { bot: true }, createdAt: new Date() }]
      ]);
      const mockChannel = {
        id: 'channel-1',
        permissionsFor: mock(() => ({ has: () => true })),
        type: 0,
        isTextBased: () => true,
        messages: { fetch: mock(async () => ({ filter: mock(() => mockMessages) })) }
      };

      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => '1h');
      interaction.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction.channel = { type: 0, messages: { fetch: mock(async () => mockMessages) } };
      // @ts-expect-error - mock guild
      interaction.guild = {
        channels: {
          cache: {
            filter: mock(() => new Map([['channel-1', mockChannel]]))
          }
        }
      };

      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('neutralizes mass mentions in generated digest output', async () => {
      mockRegistry.getTextProvider = mock(() => ({
        name: 'openai',
        capabilities: {},
        generateText: mock(async () => ({
          content: 'Summary says @everyone should check this and @here should react.',
          model: 'test-model'
        }))
      }));

      const mockMessages = new Map([
        [
          'msg1',
          {
            content: 'launch update',
            author: { bot: false, id: 'user-1', username: 'alice' },
            createdAt: new Date()
          }
        ]
      ]);
      const mockChannel = {
        id: 'channel-1',
        permissionsFor: mock(() => ({ has: () => true })),
        type: 0,
        isTextBased: () => true,
        messages: { fetch: mock(async () => ({ filter: mock(() => mockMessages) })) }
      };

      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => '1h');
      interaction.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock guild
      interaction.guild = {
        channels: {
          cache: {
            filter: mock(() => new Map([['channel-1', mockChannel]]))
          }
        }
      };

      await command.execute(interaction as any);

      const replies = interaction._getReplies();
      const payload = replies.at(-1) as { embeds: Array<{ data: { description: string } }> };
      const [embed] = payload.embeds;
      expect(embed).toBeDefined();
      const description = embed!.data.description;
      expect(description).not.toContain('@everyone');
      expect(description).not.toContain('@here');
      expect(description).toContain('everyone should check this');
      expect(description).toContain('here should react');
    });

    test('parses different period formats', async () => {
      const interaction1 = createMockInteraction();
      interaction1.options.getString = mock(() => 'daily');
      interaction1.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction1.channel = { type: 0, messages: { fetch: mock(async () => new Map()) } };

      await command.execute(interaction1 as any);
      expect(interaction1.deferReply).toHaveBeenCalled();

      const interaction2 = createMockInteraction();
      interaction2.options.getString = mock(() => 'weekly');
      interaction2.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction2.channel = { type: 0, messages: { fetch: mock(async () => new Map()) } };

      await command.execute(interaction2 as any);
      expect(interaction2.deferReply).toHaveBeenCalled();
    });
  });
});
