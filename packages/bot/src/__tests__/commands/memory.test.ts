/**
 * Tests for Memory Commands
 *
 * Tests view, set, and clear memory commands.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockDatabaseAdapter } from '@silo/core/test-setup';
import { ViewMemoryCommand } from '../../commands/memory/view';
import { SetMemoryCommand } from '../../commands/memory/set';
import { ClearMemoryCommand } from '../../commands/memory/clear';

describe('ViewMemoryCommand', () => {
  let command: ViewMemoryCommand;

  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabaseAdapter();
    mockDb.getUserMemories = mock(async () => []);
    command = new ViewMemoryCommand(mockDb);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('memory-view');
    });

    test('has correct description', () => {
      expect(command.data.description).toBe('View your stored memories');
    });
  });

  describe('execute', () => {
    test('defers reply with ephemeral', async () => {
      const interaction = createMockInteraction({
        options: {}
      });

      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    });

    test('shows no memories message when empty', async () => {
      mockDb.getUserMemories = mock(async () => []);

      const interaction = createMockInteraction({
        options: {}
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toBe('No memories found.');
    });

    test('displays memories in embed', async () => {
      mockDb.getUserMemories = mock(async () => [
        {
          id: '12345678-1234-1234-1234-123456789012',
          userId: '111222333',
          memoryContent: 'Test memory content',
          contextType: 'preference',
          createdAt: new Date()
        }
      ]);

      const interaction = createMockInteraction({
        options: {}
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0] as { embeds: unknown[] };
      expect(reply.embeds).toBeDefined();
      expect(reply.embeds.length).toBeGreaterThan(0);
    });

    test('filters by type when specified', async () => {
      const interaction = createMockInteraction({
        options: {
          type: 'preference'
        }
      });

      await command.execute(interaction as any);

      expect(mockDb.getUserMemories).toHaveBeenCalledWith('111222333', 'preference');
    });

    test('truncates long memory content', async () => {
      const longContent = 'a'.repeat(300);
      mockDb.getUserMemories = mock(async () => [
        {
          id: '12345678-1234-1234-1234-123456789012',
          userId: '111222333',
          memoryContent: longContent,
          contextType: 'conversation',
          createdAt: new Date()
        }
      ]);

      const interaction = createMockInteraction({
        options: {}
      });

      await command.execute(interaction as any);

      // Should complete without error and truncate content
      expect(interaction._getReplies().length).toBeGreaterThan(0);
    });
  });
});

describe('SetMemoryCommand', () => {
  let command: SetMemoryCommand;

  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabaseAdapter();
    mockDb.storeUserMemory = mock(
      async (opts: { userId: string; memoryContent: string; contextType: string }) => ({
        id: 'new-memory-id',
        ...opts,
        createdAt: new Date()
      })
    );
    command = new SetMemoryCommand(mockDb);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('memory-set');
    });
  });

  describe('execute', () => {
    test('stores memory with required fields', async () => {
      const interaction = createMockInteraction({
        options: {
          content: 'I prefer dark mode',
          type: 'preference'
        }
      });

      await command.execute(interaction as any);

      expect(mockDb.storeUserMemory).toHaveBeenCalled();
      const reply = interaction._getReplies()[0] as string;
      expect(reply).toContain('Memory stored successfully');
    });

    test('stores memory with expiration', async () => {
      const interaction = createMockInteraction({
        options: {
          content: 'Temporary note',
          type: 'temporary',
          'expires-in-hours': 24
        }
      });

      await command.execute(interaction as any);

      expect(mockDb.storeUserMemory).toHaveBeenCalled();
      const reply = interaction._getReplies()[0] as string;
      expect(reply).toContain('expires');
    });
  });
});

describe('ClearMemoryCommand', () => {
  let command: ClearMemoryCommand;

  let mockDb: any;

  beforeEach(() => {
    mockDb = createMockDatabaseAdapter();
    mockDb.deleteUserMemory = mock(async () => { });
    mockDb.getUserMemories = mock(async () => [{ id: 'mem1' }, { id: 'mem2' }]);
    mockDb.findUserMemoryByIdPrefix = mock(async (userId: string, idPrefix: string) => ({
      id: `${idPrefix}-full-uuid`,
      userId,
      memoryContent: 'test memory',
      contextType: 'conversation'
    }));
    command = new ClearMemoryCommand(mockDb);
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('memory-clear');
    });
  });

  describe('execute', () => {
    test('requires id or type', async () => {
      const interaction = createMockInteraction({
        options: {}
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toContain('specify either a memory ID or type');
    });

    test('deletes specific memory by id', async () => {
      const interaction = createMockInteraction({
        options: {
          id: 'specific-memory-id'
        }
      });

      await command.execute(interaction as any);

      expect(mockDb.findUserMemoryByIdPrefix).toHaveBeenCalled();
      expect(mockDb.deleteUserMemory).toHaveBeenCalledWith('specific-memory-id-full-uuid');
      const reply = interaction._getReplies()[0];
      expect(reply).toContain('deleted successfully');
    });

    test('deletes all memories of type', async () => {
      const interaction = createMockInteraction({
        options: {
          type: 'temporary'
        }
      });

      await command.execute(interaction as any);

      expect(mockDb.getUserMemories).toHaveBeenCalled();
      expect(mockDb.deleteUserMemory).toHaveBeenCalledTimes(2);
      const reply = interaction._getReplies()[0];
      expect(reply).toContain('Deleted 2');
    });
  });
});
