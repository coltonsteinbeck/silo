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
  describe('data', () => {
    test('has correct command name "stopspeaking"', () => {
      expect(StopSpeakingCommand.data.name).toBe('stopspeaking');
    });

    test('has user-friendly description', () => {
      expect(StopSpeakingCommand.data.description).toBe('Stop your voice conversation with Silo');
    });

    test('exports valid slash command JSON', () => {
      const json = StopSpeakingCommand.data.toJSON();
      expect(json).toBeDefined();
      expect(json.name).toBe('stopspeaking');
    });

    test('has no required options', () => {
      const json = StopSpeakingCommand.data.toJSON();
      expect(json.options?.length ?? 0).toBe(0);
    });
  });
});
