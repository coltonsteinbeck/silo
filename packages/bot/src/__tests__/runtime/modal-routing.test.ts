import { describe, expect, mock, test } from 'bun:test';
import type { ModalSubmitInteraction } from 'discord.js';
import type { AdminAdapter } from '../../database/admin-adapter';
import { handleModalSubmit } from '../../app';

describe('runtime feedback modal routing', () => {
  test('routes each registered feedback type to storage exactly once', async () => {
    for (const feedbackType of ['bug', 'feature', 'general', 'praise']) {
      const submitFeedback = mock(async () => {});
      const reply = mock(async () => {});
      const interaction = {
        customId: `feedback_modal_${feedbackType}`,
        guildId: 'guild-a',
        user: { id: 'user-a', username: 'tester' },
        fields: {
          getTextInputValue: (id: string) =>
            id === 'feedback_content' ? 'Synthetic feedback content.' : ''
        },
        reply
      } as unknown as ModalSubmitInteraction;
      await handleModalSubmit(interaction, { submitFeedback } as unknown as AdminAdapter);
      expect(submitFeedback).toHaveBeenCalledTimes(1);
      expect(submitFeedback).toHaveBeenCalledWith({
        guildId: 'guild-a',
        userId: 'user-a',
        username: 'tester',
        feedbackType,
        content: 'Synthetic feedback content.',
        context: null
      });
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Thank you'),
          ephemeral: true
        })
      );
    }
  });

  test('rejects unrelated or malformed feedback identifiers without storing', async () => {
    for (const customId of [
      'unrelated_modal',
      'feedback_modal_general_extra',
      'feedback_modal_unknown'
    ]) {
      const submitFeedback = mock(async () => {});
      const reply = mock(async () => {});
      await handleModalSubmit(
        { customId, reply } as unknown as ModalSubmitInteraction,
        { submitFeedback } as unknown as AdminAdapter
      );
      expect(submitFeedback).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'Unknown modal submission.' })
      );
    }
  });
});
