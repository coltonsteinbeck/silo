/**
 * Tests for Thread Command
 *
 * Tests AI conversation thread creation.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { GuildMember } from 'discord.js';
import {
  createMockInteraction as createBaseInteraction,
  createMockDatabaseAdapter
} from '@silo/core/test-setup';
import { ThreadCommand } from '../../commands/thread';
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

describe('ThreadCommand', () => {
  let command: ThreadCommand;

  let mockDb: any;

  let mockRegistry: any;

  afterEach(() => mock.restore());

  beforeEach(() => {
    spyOn(safety, 'evaluateSafetyDecision').mockResolvedValue({
      action: 'allow',
      failed: false
    } as any);
    mockDb = createMockDatabaseAdapter();
    mockRegistry = {
      getTextProvider: mock(() => ({
        name: 'openai',
        capabilities: {},
        generateText: mock(async () => ({ content: 'AI Generated Name', model: 'test-model' }))
      })),
      getProvider: mock(() => ({
        name: 'openai',
        capabilities: {},
        generateText: mock(async () => ({ content: 'AI Generated Name', model: 'test-model' }))
      })),
      getConfiguredTextModel: mock(() => 'test-model'),
      getTextRoute: mock(() => ({
        provider: mockRegistry.getTextProvider(),
        options: { model: 'test-model', reasoning: { effort: 'none' } }
      })),
      isConfigured: mock(() => true)
    };
    command = new ThreadCommand(
      mockDb,
      mockRegistry,
      {} as any,
      undefined,
      async () => 'active-hash'
    );
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('thread');
    });

    test('has correct description', () => {
      expect(command.data.description).toContain('thread');
    });

    test('has name option', () => {
      const json = command.data.toJSON();
      const nameOption = json.options?.find(opt => opt.name === 'name');
      expect(nameOption).toBeDefined();
    });
  });

  describe('execute', () => {
    test('handles missing channel', async () => {
      const interaction = createMockInteraction({
        guildId: undefined
      });
      // @ts-expect-error - mock doesn't have all properties
      interaction.guildId = null;
      // @ts-expect-error - remove channel
      interaction.channel = null;

      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('defers reply on execution', async () => {
      const mockChannel = {
        id: 'channel123',
        type: 0, // GuildText
        isTextBased: () => true,
        threads: {
          create: mock(async () => ({
            id: 'thread123',
            name: 'Test Thread',
            send: mock(async () => {})
          }))
        }
      };

      const interaction = createMockInteraction({
        options: { name: 'AI discussion' }
      });
      interaction.options.getString = mock((name: string) =>
        name === 'name' ? 'AI discussion' : null
      );
      // @ts-expect-error - adding mock channel
      interaction.channel = mockChannel;

      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('neutralizes mass mentions in generated thread names', async () => {
      mockDb.getPromptContext = mock(async () => ({
        messages: [
          {
            role: 'user',
            content: 'Plan the launch update',
            createdAt: new Date()
          }
        ]
      }));
      mockRegistry.getTextProvider = mock(() => ({
        name: 'openai',
        capabilities: {},
        generateText: mock(async () => ({
          content: '@everyone launch room',
          model: 'test-model'
        }))
      }));

      const createThread = mock(async ({ name }: { name: string }) => ({
        id: 'thread123',
        name,
        toString: (): string => `<#thread123>`,
        send: mock(async () => {})
      }));
      const mockChannel = {
        id: 'channel123',
        type: 0,
        isTextBased: () => true,
        threads: {
          create: createThread
        }
      };

      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => null);
      // @ts-expect-error - adding mock channel
      interaction.channel = mockChannel;

      await command.execute(interaction as any);

      expect(createThread).toHaveBeenCalled();
      const [firstCall] = createThread.mock.calls;
      expect(firstCall).toBeDefined();
      expect(firstCall![0].name).toBe('everyone launch room');
    });

    test('falls back to a valid default when the generated thread name is empty', async () => {
      mockDb.getPromptContext = mock(async () => ({
        messages: [
          {
            role: 'user',
            content: 'Need a name',
            createdAt: new Date()
          }
        ]
      }));
      mockRegistry.getTextProvider = mock(() => ({
        name: 'openai',
        capabilities: {},
        generateText: mock(async () => ({
          content: '   ',
          model: 'test-model'
        }))
      }));

      const createThread = mock(async ({ name }: { name: string }) => ({
        id: 'thread123',
        name,
        toString: (): string => `<#thread123>`,
        send: mock(async () => {})
      }));
      const mockChannel = {
        id: 'channel123',
        type: 0,
        isTextBased: () => true,
        threads: {
          create: createThread
        }
      };

      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => null);
      interaction.user.username = 'tester';
      // @ts-expect-error - adding mock channel
      interaction.channel = mockChannel;

      await command.execute(interaction as any);

      const [firstCall] = createThread.mock.calls;
      expect(firstCall).toBeDefined();
      expect(firstCall![0].name).toBe('Chat with tester');
    });

    test('falls back to the default thread name when there is no conversation history', async () => {
      mockDb.getPromptContext = mock(async () => ({ messages: [] }));

      const createThread = mock(async ({ name }: { name: string }) => ({
        id: 'thread123',
        name,
        toString: (): string => `<#thread123>`,
        send: mock(async () => {})
      }));
      const mockChannel = {
        id: 'channel123',
        type: 0,
        isTextBased: () => true,
        threads: {
          create: createThread
        }
      };

      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => null);
      interaction.user.username = 'tester';
      // @ts-expect-error - adding mock channel
      interaction.channel = mockChannel;

      await command.execute(interaction as any);

      expect(createThread).toHaveBeenCalled();
      const [firstCall] = createThread.mock.calls;
      expect(firstCall).toBeDefined();
      expect(firstCall![0].name).toBe('Chat with tester');
    });
  });
});
