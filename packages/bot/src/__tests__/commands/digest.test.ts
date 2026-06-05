/**
 * Tests for Digest Command
 *
 * Tests conversation digest/summary functionality.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction } from '@silo/core/test-setup';
import { DigestCommand } from '../../commands/digest';

describe('DigestCommand', () => {
  let command: DigestCommand;

  let mockRegistry: any;

  beforeEach(() => {
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
      isConfigured: mock(() => true)
    };
    command = new DigestCommand(mockRegistry);
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
