import type { TextGenerationFinishReason } from '@silo/core';

export function normalizeTextGenerationFinishReason(
  providerFinishReason: string | null | undefined
): TextGenerationFinishReason | undefined {
  const normalized = providerFinishReason?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (['stop', 'end_turn', 'stop_sequence'].includes(normalized)) {
    return 'stop';
  }

  if (['length', 'max_tokens', 'max_output_tokens'].includes(normalized)) {
    return 'length';
  }

  if (['content_filter', 'safety', 'blocked', 'refusal'].includes(normalized)) {
    return 'content_filter';
  }

  if (['tool_calls', 'tool_call', 'tool_use'].includes(normalized)) {
    return 'tool_calls';
  }

  return 'other';
}
