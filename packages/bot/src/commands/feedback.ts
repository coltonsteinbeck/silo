import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalActionRowComponentBuilder
} from 'discord.js';
import type { Command } from './types';
import type { AdminAdapter } from '../database/admin-adapter';

export class FeedbackCommand implements Command {
  data = new SlashCommandBuilder()
    .setName('feedback')
    .setDescription('Submit feedback about Silo')
    .addStringOption(option =>
      option
        .setName('type')
        .setDescription('Type of feedback')
        .setRequired(true)
        .addChoices(
          { name: 'Bug Report', value: 'bug' },
          { name: 'Feature Request', value: 'feature' },
          { name: 'General Feedback', value: 'general' },
          { name: 'Praise', value: 'praise' }
        )
    );

  private adminDb: AdminAdapter;

  constructor(adminDb: AdminAdapter) {
    this.adminDb = adminDb;
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const feedbackType = interaction.options.getString('type', true);

    // Show a modal for detailed feedback
    const modal = new ModalBuilder()
      .setCustomId(`feedback_modal_${feedbackType}`)
      .setTitle('Submit Feedback');

    const feedbackInput = new TextInputBuilder()
      .setCustomId('feedback_content')
      .setLabel('Your feedback')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Please describe your feedback in detail...')
      .setRequired(true)
      .setMinLength(10)
      .setMaxLength(2000);

    const contextInput = new TextInputBuilder()
      .setCustomId('feedback_context')
      .setLabel('Additional context (optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., which command, what you expected...')
      .setRequired(false)
      .setMaxLength(500);

    const row1 = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
      feedbackInput
    );
    const row2 = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(contextInput);

    modal.addComponents(row1, row2);

    await interaction.showModal(modal);
  }

  /**
   * Handle modal submission (called from interaction handler)
   */
  async handleModalSubmit(interaction: {
    customId: string;
    guildId: string | null;
    user: { id: string; username: string };
    fields: { getTextInputValue: (id: string) => string };
    reply: (options: { content: string; ephemeral: boolean }) => Promise<void>;
  }): Promise<void> {
    const feedbackType = interaction.customId.replace('feedback_modal_', '');
    const content = interaction.fields.getTextInputValue('feedback_content');
    const context = interaction.fields.getTextInputValue('feedback_context') || null;

    try {
      // Store feedback in database
      await this.adminDb.submitFeedback({
        guildId: interaction.guildId || 'dm',
        userId: interaction.user.id,
        username: interaction.user.username,
        feedbackType: feedbackType as 'bug' | 'feature' | 'general' | 'praise',
        content,
        context
      });

      const typeLabels: Record<string, string> = {
        bug: 'Bug Report',
        feature: 'Feature Request',
        general: 'General Feedback',
        praise: 'Praise'
      };

      await interaction.reply({
        content: `Thank you for your ${typeLabels[feedbackType] || 'feedback'}! Your input helps improve Silo.`,
        ephemeral: true
      });
    } catch (error) {
      console.error('[FeedbackCommand] Error saving feedback:', error);
      await interaction.reply({
        content: 'There was an error submitting your feedback. Please try again later.',
        ephemeral: true
      });
    }
  }
}
