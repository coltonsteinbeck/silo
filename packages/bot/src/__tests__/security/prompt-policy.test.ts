import { describe, expect, test } from 'bun:test';
import {
  resolvePromptPolicy,
  hashPrompt,
  parseAllowedPromptHashes
} from '../../security/prompt-policy';

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
      allowedPromptHashesRaw: 'ffffffffffffffff'
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

  test('normalizes empty and whitespace-only custom prompt to default', () => {
    const empty = resolvePromptPolicy({
      customPrompt: '',
      defaultPrompt: 'default prompt'
    });
    const whitespace = resolvePromptPolicy({
      customPrompt: '   \n\t  ',
      defaultPrompt: 'default prompt'
    });

    expect(empty.effectivePrompt).toBe('default prompt');
    expect(empty.usedCustomPrompt).toBe(false);
    expect(whitespace.effectivePrompt).toBe('default prompt');
    expect(whitespace.usedCustomPrompt).toBe(false);
  });

  test('uses trimmed custom prompt for hashing and allowlist matching', () => {
    const trimmedPrompt = 'custom policy prompt';
    const spacedPrompt = `   ${trimmedPrompt}   `;
    const expectedHash = hashPrompt(trimmedPrompt);

    const result = resolvePromptPolicy({
      customPrompt: spacedPrompt,
      defaultPrompt: 'default prompt',
      allowedPromptHashesRaw: `, ${expectedHash} ,`
    });

    expect(result.effectivePrompt).toBe(trimmedPrompt);
    expect(result.promptHash).toBe(expectedHash);
    expect(result.usedCustomPrompt).toBe(true);
  });

  test('produces distinct 16-char hashes for different long prompts', () => {
    const promptA = `Prompt A ${'x'.repeat(300)}`;
    const promptB = `Prompt B ${'x'.repeat(300)}`;
    const hashA = hashPrompt(promptA);
    const hashB = hashPrompt(promptB);

    expect(hashA).toHaveLength(16);
    expect(hashB).toHaveLength(16);
    expect(hashA).not.toBe(hashB);

    const accepted = resolvePromptPolicy({
      customPrompt: promptA,
      defaultPrompt: 'default prompt',
      allowedPromptHashesRaw: hashA
    });
    const rejected = resolvePromptPolicy({
      customPrompt: promptB,
      defaultPrompt: 'default prompt',
      allowedPromptHashesRaw: hashA
    });

    expect(accepted.usedCustomPrompt).toBe(true);
    expect(rejected.usedCustomPrompt).toBe(false);
    expect(rejected.rejectedCustomPrompt).toBe(true);
  });

  test('parseAllowedPromptHashes filters malformed values and resolvePromptPolicy enforces safely', () => {
    const validHash = hashPrompt('good prompt');
    const parsed = parseAllowedPromptHashes(
      ` ${validHash},not_a_hash, ,%%%%,123,${validHash.toUpperCase()},ffffffffffffffff `
    );

    expect(parsed.has(validHash)).toBe(true);
    expect(parsed.has(validHash.toUpperCase())).toBe(true);
    expect(parsed.has('not_a_hash')).toBe(false);
    expect(parsed.has('123')).toBe(false);

    const result = resolvePromptPolicy({
      customPrompt: 'good prompt',
      defaultPrompt: 'default prompt',
      allowedPromptHashesRaw: `,bad,${validHash},,,,,`
    });

    expect(result.usedCustomPrompt).toBe(true);
    expect(result.rejectedCustomPrompt).toBe(false);
  });
});
