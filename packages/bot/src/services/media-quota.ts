// Conservative internal quota estimates, not a provider billing receipt.
// Video rates are per second; reference images are charged once per request.
export function calculateVideoQuotaCost(
  duration: number,
  resolution: string,
  referenceCount: number
): number {
  if (
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 10 ||
    !['480p', '720p'].includes(resolution) ||
    !Number.isInteger(referenceCount) ||
    referenceCount < 0 ||
    referenceCount > 2
  ) {
    throw new Error(
      'Video generation requires 1–10 seconds, 480p or 720p, and at most two references.'
    );
  }
  const unitsPerSecond = resolution === '720p' ? 70 : 40;
  return duration * unitsPerSecond + referenceCount * 5;
}
