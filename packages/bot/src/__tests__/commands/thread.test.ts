/**
 * Tests for Thread Command
 * 
 * Tests AI conversation thread creation.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockDatabaseAdapter } from '@silo/core/test-setup';
import { ThreadCommand } from '../../commands/thread';

describe('ThreadCommand', () => {
  let command: ThreadCommand;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRegistry: any;

  beforeEach(() => {
    mockDb = createMockDatabaseAdapter();
    mockRegistry = {
      getTextProvider: mock(() => ({
        generateText: mock(async () => 'AI Generated Name')
      })),
      getProvider: mock(() => ({
        generateText: mock(async () => 'AI Generated Name')
      })),
      isConfigured: mock(() => true)
    };
    command = new ThreadCommand(mockDb, mockRegistry);
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      interaction.options.getString = mock((name: string) => name === 'name' ? 'AI discussion' : null);
      // @ts-expect-error - adding mock channel
      interaction.channel = mockChannel;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });
  });
});
