export const DEFAULT_MAX_TEXT_RESPONSE_TOKENS = 400;

export function resolveTextResponseTokenLimit(remainingTokens: number): number {
  if (!Number.isFinite(remainingTokens)) {
    return DEFAULT_MAX_TEXT_RESPONSE_TOKENS;
  }

  return Math.max(0, Math.min(DEFAULT_MAX_TEXT_RESPONSE_TOKENS, Math.floor(remainingTokens)));
}
