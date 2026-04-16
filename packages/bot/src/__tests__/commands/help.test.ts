import { describe, test, expect } from 'bun:test';
import { createMockInteraction } from '@silo/core/test-setup';
import { HelpCommand } from '../../commands/help';

describe('HelpCommand', () => {
  test('has expected command metadata', () => {
    const command = new HelpCommand();
    expect(command.data.name).toBe('help');
    expect(command.data.description).toContain('available commands');
  });

  test('responds with command reference', async () => {
    const command = new HelpCommand();
    const interaction = createMockInteraction();

    await command.execute(interaction as any);

    const reply = interaction._getReplies()[0] as { content: string; ephemeral: boolean };
    expect(reply.content).toContain('/admin');
    expect(reply.content).toContain('/help');
    expect(reply.ephemeral).toBe(true);
  });
});
