import type { logger as coreLogger } from '@silo/core';
import { awaitTracingShutdown } from './tracing-shutdown';

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
  function handleFatalRuntimeError(message: string, error: unknown): void {
    void (async () => {
      log.error(message, error);

      try {
        const tracingShutdownOutcome = await awaitTracingShutdown({
          shutdownTracing,
          timeoutMs: tracingShutdownTimeoutMs
        });
        if (tracingShutdownOutcome === 'timed_out') {
          log.warn('Tracing shutdown timed out after fatal runtime error', {
            tracingShutdownTimeoutMs
          });
        }
      } catch (shutdownError) {
        log.warn('Tracing shutdown failed after fatal runtime error', shutdownError);
      }

      exit(1);
    })();
  }

  process.on('uncaughtException', error => {
    handleFatalRuntimeError('Uncaught exception:', error);
  });

  process.on('unhandledRejection', reason => {
    handleFatalRuntimeError('Unhandled promise rejection:', reason);
  });
}
