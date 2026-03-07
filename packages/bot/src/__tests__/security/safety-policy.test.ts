import { describe, test, expect } from 'bun:test';
import {
  IMMUTABLE_SAFETY_POLICY,
  composeSystemPromptWithSafety
} from '../../security/safety-policy';

describe('safety-policy', () => {
  test('appends immutable policy to base prompt', () => {
    const base = 'You are a helpful Discord bot.';
    const composed = composeSystemPromptWithSafety(base);

    expect(composed).toContain(base);
    expect(composed).toContain('SAFETY_POLICY_V1');
    expect(composed).toContain('instruction hierarchy');
  });

  test('returns policy when base prompt is empty', () => {
    const composed = composeSystemPromptWithSafety('   ');

    expect(composed).toBe(IMMUTABLE_SAFETY_POLICY.trim());
  });

  test('does not duplicate policy marker when already present', () => {
    const existing = `Custom\n\n${IMMUTABLE_SAFETY_POLICY.trim()}`;
    const composed = composeSystemPromptWithSafety(existing);

    expect(composed).toBe(existing);
    expect(composed.match(/SAFETY_POLICY_V1/g)?.length).toBe(1);
  });
});
