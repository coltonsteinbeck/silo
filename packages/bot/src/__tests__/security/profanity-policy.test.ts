import { describe, expect, test } from 'bun:test';
import { detectMildProfanity, sanitizeAssistantProfanity } from '../../security/profanity-policy';

describe('profanity-policy', () => {
  test('detects mild profanity terms', () => {
    const matches = detectMildProfanity('this is fucking annoying and total bullshit');
    expect(matches).toContain('fucking');
    expect(matches).toContain('bullshit');
  });

  test('sanitizes assistant profanity output', () => {
    const result = sanitizeAssistantProfanity('That is a shit plan, what the hell.');
    expect(result.changed).toBe(true);
    expect(result.sanitized).toContain('*** plan');
    expect(result.sanitized).toContain('the ***.');
    expect(result.matchedTerms).toContain('shit');
  });
});
