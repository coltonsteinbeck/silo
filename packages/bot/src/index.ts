import { logger } from '@silo/core';
import { awaitTracingShutdown } from './runtime/tracing-shutdown';
import { loadVoiceEncryptionSupport } from './runtime/voice-encryption';
import { shutdownLangfuseTracing } from './telemetry/langfuse-client';

const STARTUP_TRACING_SHUTDOWN_TIMEOUT_MS = 1000;

try {
  loadVoiceEncryptionSupport(logger);
  const { startBot } = await import('./app');
  await startBot();
} catch (error) {
  let tracingShutdownOutcome = 'completed';

  try {
    const outcome = await awaitTracingShutdown({
      shutdownTracing: shutdownLangfuseTracing,
      timeoutMs: STARTUP_TRACING_SHUTDOWN_TIMEOUT_MS
    });
    if (outcome === 'timed_out') {
      tracingShutdownOutcome = `timed_out_after_${STARTUP_TRACING_SHUTDOWN_TIMEOUT_MS}ms`;
    }
  } catch (shutdownError) {
    tracingShutdownOutcome =
      shutdownError instanceof Error ? shutdownError.message : String(shutdownError);
  }

  logger.error('Fatal startup error', {
    error,
    tracingShutdownOutcome
  });
  process.exit(1);
}
