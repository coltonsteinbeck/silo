/**
 * Tests for Speak Command
 * 
 * Tests voice channel join functionality.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { createMockInteraction, createMockAdminAdapter } from '@silo/core/test-setup';
import { SpeakCommand } from '../../commands/speak';

describe('SpeakCommand', () => {
  let command: SpeakCommand;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockAdminDb: any;

  beforeEach(() => {
    mockAdminDb = createMockAdminAdapter();
    command = new SpeakCommand(mockAdminDb);
  });

  describe('data', () => {
    test('has correct command name "speak"', () => {
      expect(command.data.name).toBe('speak');
    });

    test('has description mentioning voice functionality', () => {
      expect(command.data.description).toContain('voice');
    });

    test('includes voice selection option', () => {
      const json = command.data.toJSON();
      const voiceOption = json.options?.find(opt => opt.name === 'voice');
      expect(voiceOption).toBeDefined();
    });

    test('exports valid slash command JSON', () => {
      const json = command.data.toJSON();
      expect(json.name).toBe('speak');
      expect(json.description).toBeDefined();
    });
  });

  describe('execute', () => {
    test('rejects when user is not in voice channel', async () => {
      const mockMember = {
        id: '111222333',
        permissions: { has: () => true },
        roles: { cache: new Map() },
        voice: { channel: null }
      };

      const interaction = createMockInteraction({
        member: mockMember as any
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect((reply as { content: string }).content).toContain('voice channel');
    });

    test('rejects invalid channel types', async () => {
      const mockVoiceChannel = {
        id: 'voice123',
        name: 'General',
        guild: { id: 'guild123' },
        type: 0, // GuildText - invalid for voice
        permissionsFor: () => ({ has: () => true })
      };

      const mockMember = {
        id: '111222333',
        permissions: { has: () => true },
        roles: { cache: new Map() },
        voice: { channel: mockVoiceChannel }
      };

      const interaction = createMockInteraction({
        member: mockMember as any
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect((reply as { content: string }).content).toContain('voice channel');
    });
  });
});
