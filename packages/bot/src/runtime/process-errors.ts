import type { logger as coreLogger } from '@silo/core';

type Logger = typeof coreLogger;

export function installProcessErrorHandlers({
  log,
  shutdownTracing,
  exit = process.exit,
  tracingShutdownTimeoutMs = 1000
}: {
  log: Logger;
  shutdownTracing: () => Promise<void>;
  exit?: (code?: number) => never;
  tracingShutdownTimeoutMs?: number;
}): void {
  async function waitForTracingShutdown(): Promise<'completed' | 'timed_out'> {
    if (tracingShutdownTimeoutMs <= 0) {
      await shutdownTracing();
      return 'completed';
    }

    return Promise.race([
      shutdownTracing().then(() => 'completed' as const),
      new Promise<'timed_out'>(resolve => {
        setTimeout(() => resolve('timed_out'), tracingShutdownTimeoutMs);
      })
    ]);
  }

  process.on('uncaughtException', error => {
    void (async () => {
      log.error('Uncaught exception:', error);

      try {
        const tracingShutdownOutcome = await waitForTracingShutdown();
        if (tracingShutdownOutcome === 'timed_out') {
          log.warn('Tracing shutdown timed out after uncaught exception', {
            tracingShutdownTimeoutMs
          });
        }
      } catch (shutdownError) {
        log.warn('Tracing shutdown failed after uncaught exception', shutdownError);
      }

      exit(1);
    })();
  });

  process.on('unhandledRejection', reason => {
    log.error('Unhandled promise rejection:', reason);
  });
}
