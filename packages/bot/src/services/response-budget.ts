export const DEFAULT_MAX_TEXT_RESPONSE_TOKENS = 400;

export function resolveTextResponseTokenLimit(
  remainingTokens: number,
  configuredLimit = DEFAULT_MAX_TEXT_RESPONSE_TOKENS
): number {
  if (!Number.isFinite(remainingTokens)) {
    return configuredLimit;
  }

  return Math.max(0, Math.min(configuredLimit, Math.floor(remainingTokens)));
}
