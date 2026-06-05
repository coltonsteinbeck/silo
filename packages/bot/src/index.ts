import { logger } from '@silo/core';
import { loadVoiceEncryptionSupport } from './runtime/voice-encryption';
import { shutdownLangfuseTracing } from './telemetry/langfuse-client';

try {
  loadVoiceEncryptionSupport(logger);
  const { startBot } = await import('./app');
  await startBot();
} catch (error) {
  let tracingShutdownOutcome = 'completed';

  try {
    await shutdownLangfuseTracing();
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
