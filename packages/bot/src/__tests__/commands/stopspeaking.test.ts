/**
 * Tests for StopSpeaking Command
 *
 * Tests voice session termination command.
 * Note: Full execute tests require mocking voiceSessionManager
 * which has complex dependencies on Discord.js voice connections.
 */

import { describe, test, expect } from 'bun:test';
import { StopSpeakingCommand } from '../../commands/stopspeaking';

describe('StopSpeakingCommand', () => {
  // Create an instance for testing (no quota middleware for basic tests)
  const command = new StopSpeakingCommand();

  describe('data', () => {
    test('has correct command name "stopspeaking"', () => {
      expect(command.data.name).toBe('stopspeaking');
    });

    test('has user-friendly description', () => {
      expect(command.data.description).toBe('Stop your voice conversation with Silo');
    });

    test('exports valid slash command JSON', () => {
      const json = command.data.toJSON();
      expect(json).toBeDefined();
      expect(json.name).toBe('stopspeaking');
    });

    test('has no required options', () => {
      const json = command.data.toJSON();
      expect(json.options?.length ?? 0).toBe(0);
    });
  });
});
