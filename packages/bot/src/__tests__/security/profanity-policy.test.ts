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

  test('replaces all repeated occurrences and tracks each detection', () => {
    const detected = detectMildProfanity('fuck fuck');
    const result = sanitizeAssistantProfanity('fuck fuck');

    expect(detected).toContain('fuck');
    expect(result.sanitized).toBe('*** ***');
    expect(result.matchedTerms).toEqual(['fuck', 'fuck']);
  });

  test('does not sanitize partial-word matches', () => {
    const input = 'shitake is tasty and scunthorpe is a town';
    const detected = detectMildProfanity(input);
    const result = sanitizeAssistantProfanity(input);

    expect(detected).toHaveLength(0);
    expect(result.changed).toBe(false);
    expect(result.sanitized).toBe(input);
    expect(result.matchedTerms).toHaveLength(0);
  });

  test('sanitizes profanity case-insensitively', () => {
    const input = 'FUCK FuCk';
    const detected = detectMildProfanity(input);
    const result = sanitizeAssistantProfanity(input);

    expect(detected).toContain('fuck');
    expect(result.sanitized).toBe('*** ***');
    expect(result.matchedTerms).toEqual(['fuck', 'fuck']);
  });
});
