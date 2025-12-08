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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockRegistry: any;

  beforeEach(() => {
    mockRegistry = {
      getTextProvider: mock(() => ({
        generateText: mock(async () => 'Summary text')
      })),
      getProvider: mock(() => ({
        generateText: mock(async () => 'Summary text')
      })),
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('handles no messages in period', async () => {
      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => '1h');
      interaction.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction.channel = { type: 0, messages: { fetch: mock(async () => new Map()) } };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('generates digest with messages', async () => {
      const mockMessages = new Map([
        ['msg1', { content: 'Hello', author: { bot: false }, createdAt: new Date() }],
        ['msg2', { content: 'Hi there!', author: { bot: true }, createdAt: new Date() }]
      ]);

      const interaction = createMockInteraction();
      interaction.options.getString = mock(() => '1h');
      interaction.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction.channel = { type: 0, messages: { fetch: mock(async () => mockMessages) } };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
    });

    test('parses different period formats', async () => {
      const interaction1 = createMockInteraction();
      interaction1.options.getString = mock(() => 'daily');
      interaction1.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction1.channel = { type: 0, messages: { fetch: mock(async () => new Map()) } };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction1 as any);
      expect(interaction1.deferReply).toHaveBeenCalled();

      const interaction2 = createMockInteraction();
      interaction2.options.getString = mock(() => 'weekly');
      interaction2.options.getBoolean = mock(() => false);
      // @ts-expect-error - mock channel
      interaction2.channel = { type: 0, messages: { fetch: mock(async () => new Map()) } };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction2 as any);
      expect(interaction2.deferReply).toHaveBeenCalled();
    });
  });
});
