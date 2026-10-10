import { describe, expect, test } from 'bun:test';
import { toLangfuseUsage } from '../../telemetry/langfuse-usage';

describe('Langfuse usage normalization', () => {
  test('maps provider counts without counting totals and overlapping details twice', () => {
    const usage = Object.freeze({
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      cacheReadTokens: 700,
      reasoningTokens: 300
    });
    const result = toLangfuseUsage(usage);
    expect(result).toEqual({ input: 1000, output: 1000, total: 2000 });
    expect(result!.input + result!.output).toBe(result!.total);
    expect(result!.input * 0.0000001 + result!.output * 0.0000005).toBeCloseTo(0.0006, 10);
    expect(usage.cacheReadTokens).toBe(700);
    expect(usage.reasoningTokens).toBe(300);
  });

  test('does not invent usage when the provider does not supply it', () => {
    expect(toLangfuseUsage(undefined)).toBeUndefined();
  });

  test('preserves known zero counts', () => {
    expect(toLangfuseUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toEqual({
      input: 0,
      output: 0,
      total: 0
    });
  });

  test.each([-1, NaN, Infinity, 1.5])('omits invalid usage count %s', count => {
    expect(
      toLangfuseUsage({ promptTokens: count, completionTokens: 1, totalTokens: 2 })
    ).toBeUndefined();
  });
});
