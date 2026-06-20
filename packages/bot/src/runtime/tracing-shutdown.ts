export async function awaitTracingShutdown({
  shutdownTracing,
  timeoutMs
}: {
  shutdownTracing: () => Promise<void>;
  timeoutMs: number;
}): Promise<'completed' | 'timed_out'> {
  if (timeoutMs <= 0) {
    await shutdownTracing();
    return 'completed';
  }

  return Promise.race([
    shutdownTracing().then(() => 'completed' as const),
    new Promise<'timed_out'>(resolve => {
      const timer = setTimeout(() => resolve('timed_out'), timeoutMs);
      timer.unref?.();
    })
  ]);
}
