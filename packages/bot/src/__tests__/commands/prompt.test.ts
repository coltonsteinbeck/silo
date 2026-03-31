import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockAdminAdapter, createMockInteraction } from '@silo/core/test-setup';
import { PromptCommand } from '../../commands/prompt';

describe('PromptCommand', () => {
  let mockAdminDb: any;
  let command: PromptCommand;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    command = new PromptCommand(mockAdminDb);
  });

  test('has correct command name', () => {
    expect(command.data.name).toBe('prompt');
  });

  test('rejects non-guild usage', async () => {
    const interaction = createMockInteraction({ guildId: undefined });
    // @ts-expect-error test override for guildless context
    interaction.guildId = null;

    await command.execute(interaction as any);

    const reply = interaction._getReplies()[0] as { content: string };
    expect(reply.content).toContain('only be used in a server');
  });

  test('shows configured text prompt', async () => {
    mockAdminDb.getSystemPrompt = mock(async () => ({
      prompt: 'You are a guild assistant.',
      enabled: true
    }));

    const interaction = createMockInteraction({
      options: { type: 'text' }
    });

    await command.execute(interaction as any);

    const reply = interaction._getReplies()[0] as { content: string };
    expect(reply.content).toContain('Text System Prompt');
    expect(reply.content).toContain('You are a guild assistant.');
    expect(reply.content).toContain('Length: 26 characters');
  });

  test('redacts secret-like values in prompt preview', async () => {
    mockAdminDb.getSystemPrompt = mock(async () => ({
      prompt: 'Set API_KEY=sk-test-supersecret and Authorization: Bearer abc.def.ghi',
      enabled: true
    }));

    const interaction = createMockInteraction({
      options: { type: 'text' }
    });

    await command.execute(interaction as any);

    const reply = interaction._getReplies()[0] as { content: string };
    expect(reply.content).toContain('API_KEY=[redacted-value]');
    expect(reply.content).toContain('Bearer [redacted-token]');
    expect(reply.content).toContain('Safety:');
    expect(reply.content).not.toContain('sk-test-supersecret');
  });
});
