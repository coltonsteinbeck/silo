import { describe, expect, test } from 'bun:test';
import { resolvePromptPolicy } from '../../security/prompt-policy';

describe('prompt-policy', () => {
  test('uses default prompt when no custom prompt is set', () => {
    const result = resolvePromptPolicy({
      customPrompt: null,
      defaultPrompt: 'default prompt'
    });

    expect(result.effectivePrompt).toBe('default prompt');
    expect(result.promptHash).toBe('default');
    expect(result.usedCustomPrompt).toBe(false);
    expect(result.rejectedCustomPrompt).toBe(false);
  });

  test('allows custom prompt when allowlist is not configured', () => {
    const result = resolvePromptPolicy({
      customPrompt: 'custom prompt',
      defaultPrompt: 'default prompt'
    });

    expect(result.effectivePrompt).toBe('custom prompt');
    expect(result.promptHash).toHaveLength(16);
    expect(result.usedCustomPrompt).toBe(true);
    expect(result.rejectedCustomPrompt).toBe(false);
  });

  test('rejects custom prompt when hash is not in allowlist', () => {
    const result = resolvePromptPolicy({
      customPrompt: 'custom prompt',
      defaultPrompt: 'default prompt',
      allowedPromptHashesRaw: 'abc123,def456'
    });

    expect(result.effectivePrompt).toBe('default prompt');
    expect(result.promptHash).toBe('default');
    expect(result.usedCustomPrompt).toBe(false);
    expect(result.rejectedCustomPrompt).toBe(true);
    expect(result.customPromptHash).toHaveLength(16);
  });

  test('accepts custom prompt when hash is in allowlist', () => {
    const precomputed = resolvePromptPolicy({
      customPrompt: 'custom prompt',
      defaultPrompt: 'default prompt'
    });

    const result = resolvePromptPolicy({
      customPrompt: 'custom prompt',
      defaultPrompt: 'default prompt',
      allowedPromptHashesRaw: `${precomputed.promptHash},otherhash`
    });

    expect(result.effectivePrompt).toBe('custom prompt');
    expect(result.promptHash).toBe(precomputed.promptHash);
    expect(result.usedCustomPrompt).toBe(true);
    expect(result.rejectedCustomPrompt).toBe(false);
  });
});
