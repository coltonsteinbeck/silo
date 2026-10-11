export function combineAbortSignals(
  optionalSignal: AbortSignal | undefined,
  requiredSignal: AbortSignal
): AbortSignal {
  return AbortSignal.any(optionalSignal ? [optionalSignal, requiredSignal] : [requiredSignal]);
}
