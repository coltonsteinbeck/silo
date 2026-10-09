import type { TextGenerationResponse } from '@silo/core';

/** Inclusive provider totals, priced at standard input/output rates; not discounted cache costs. */
export function toLangfuseUsage(
  usage: TextGenerationResponse['usage']
): { input: number; output: number; total: number } | undefined {
  if (!usage) return undefined;
  const { promptTokens, completionTokens, totalTokens } = usage;
  if (
    ![promptTokens, completionTokens, totalTokens].every(
      count => Number.isSafeInteger(count) && count >= 0
    )
  ) {
    return undefined;
  }

  // Reasoning/cache detail counts overlap these totals and must not become extra usage buckets.
  return { input: promptTokens, output: completionTokens, total: totalTokens };
}
