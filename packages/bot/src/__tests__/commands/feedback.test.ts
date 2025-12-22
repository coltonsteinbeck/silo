/**
 * Tests for Feedback Command
 *
 * Tests feedback submission functionality.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockAdminAdapter } from '@silo/core/test-setup';
import { FeedbackCommand } from '../../commands/feedback';

describe('FeedbackCommand', () => {
  let command: FeedbackCommand;

  let mockAdminDb: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    command = new FeedbackCommand(mockAdminDb);
  });

  describe('data', () => {
    test('has correct command name "feedback"', () => {
      expect(command.data.name).toBe('feedback');
    });

    test('has description explaining feedback purpose', () => {
      expect(command.data.description).toContain('feedback');
    });

    test('includes type option for categorizing feedback', () => {
      const json = command.data.toJSON();
      const typeOption = json.options?.find(opt => opt.name === 'type');
      expect(typeOption).toBeDefined();
    });

    test('exports valid slash command JSON', () => {
      const json = command.data.toJSON();
      expect(json.name).toBe('feedback');
      expect(json.description).toBeDefined();
    });
  });

  describe('execute', () => {
    test('shows feedback modal', async () => {
      const interaction = createMockInteraction({
        options: { type: 'bug' }
      });
      interaction.options.getString = mock(() => 'bug');

      await command.execute(interaction as any);

      expect(interaction.showModal).toHaveBeenCalled();
    });
  });

  describe('handleModalSubmit', () => {
    test('processes feedback submission', async () => {
      const mockModalInteraction = {
        customId: 'feedback_modal_bug',
        user: { id: '123456', username: 'testuser' },
        guildId: 'guild123',
        fields: {
          getTextInputValue: (id: string) => {
            if (id === 'feedback_content') return 'This is test feedback';
            if (id === 'feedback_context') return 'Some context';
            return '';
          }
        },
        reply: mock(async () => {})
      };

      mockAdminDb.submitFeedback = mock(async () => {});

      await command.handleModalSubmit(mockModalInteraction as any);

      expect(mockAdminDb.submitFeedback).toHaveBeenCalled();
      expect(mockModalInteraction.reply).toHaveBeenCalled();
    });

    test('handles DM feedback', async () => {
      const mockModalInteraction = {
        customId: 'feedback_modal_feature',
        user: { id: '123456', username: 'testuser' },
        guildId: null,
        fields: {
          getTextInputValue: (id: string) => {
            if (id === 'feedback_content') return 'This is DM feedback';
            if (id === 'feedback_context') return '';
            return '';
          }
        },
        reply: mock(async () => {})
      };

      mockAdminDb.submitFeedback = mock(async () => {});

      await command.handleModalSubmit(mockModalInteraction as any);

      expect(mockAdminDb.submitFeedback).toHaveBeenCalled();
    });
  });
});
