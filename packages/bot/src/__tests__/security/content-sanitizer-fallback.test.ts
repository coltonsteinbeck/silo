import { describe, expect, test } from 'bun:test';
import {
  buildModerationApiFailureResult,
  buildUserMessageForBlockedInput
} from '../../security/content-sanitizer';

describe('content-sanitizer failure fallback', () => {
  test('returns fail-open result when failClosedOnError is false', () => {
    const result = buildModerationApiFailureResult('hash123', false);

    expect(result.allowed).toBe(true);
    expect(result.action).toBe('allowed');
    expect(result.flaggedCategories).toEqual(['api_error']);
    expect(result.contentHash).toBe('hash123');
  });

  test('returns fail-closed result when failClosedOnError is true', () => {
    const result = buildModerationApiFailureResult('hash123', true);

    expect(result.allowed).toBe(false);
    expect(result.action).toBe('api_error_fail_closed');
    expect(result.flaggedCategories).toEqual(['api_error_fail_closed']);
    expect(result.contentHash).toBe('hash123');
  });

  test('builds clear user message for policy-blocked content', () => {
    const message = buildUserMessageForBlockedInput({
      action: 'blocked',
      flaggedCategories: ['guardrails/jailbreak']
    });

    expect(message).toContain('blocked by safety policy');
    expect(message).toContain('Please rephrase');
  });

  test('builds clear user message for fail-closed safety downtime', () => {
    const message = buildUserMessageForBlockedInput({
      action: 'api_error_fail_closed',
      flaggedCategories: ['api_error_fail_closed']
    });

    expect(message).toContain('temporarily blocked');
    expect(message).toContain('safety systems are unavailable');
  });
});
