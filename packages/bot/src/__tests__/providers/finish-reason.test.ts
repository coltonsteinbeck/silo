import { describe, expect, test } from 'bun:test';
import { normalizeTextGenerationFinishReason } from '../../providers/finish-reason';

describe('provider finish reason normalization', () => {
  test.each([
    ['stop', 'stop'],
    ['end_turn', 'stop'],
    ['length', 'length'],
    ['max_tokens', 'length'],
    ['content_filter', 'content_filter'],
    ['safety', 'content_filter'],
    ['refusal', 'content_filter'],
    ['tool_calls', 'tool_calls'],
    ['tool_use', 'tool_calls'],
    ['unexpected_provider_value', 'other']
  ] as const)('normalizes %s to %s', (providerReason, expected) => {
    expect(normalizeTextGenerationFinishReason(providerReason)).toBe(expected);
  });

  test('leaves an absent provider reason undefined', () => {
    expect(normalizeTextGenerationFinishReason(undefined)).toBeUndefined();
  });
});
