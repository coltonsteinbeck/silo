import { performance } from 'node:perf_hooks';
import type { ChatInputCommandInteraction } from 'discord.js';
import { logger } from '@silo/core';
import type { Command } from '../commands/types';
import type { AdminAdapter } from '../database/admin-adapter';

/** Record handler completion without treating it as provider usage or delivery acceptance. */
export async function executeCommandWithAnalytics(
  command: Pick<Command, 'execute'>,
  interaction: ChatInputCommandInteraction,
  analytics: Pick<AdminAdapter, 'logEvent'>
): Promise<void> {
  const started = performance.now();
  let success = false;
  try {
    await command.execute(interaction);
    success = true;
  } finally {
    if (interaction.guildId) {
      try {
        await analytics.logEvent({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          eventType: 'command_used',
          command: interaction.commandName,
          responseTimeMs: Math.max(0, Math.round(performance.now() - started)),
          success,
          metadata: { outcomeScope: 'handler_completion' }
        });
      } catch {
        // Analytics must not retry the command or replace its original failure.
        logger.warn('Command analytics could not be recorded', {
          command: interaction.commandName
        });
      }
    }
  }
}
