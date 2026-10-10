import type { Client } from 'discord.js';
import type { logger as coreLogger } from '@silo/core';
import type { PostgresAdapter } from '../database/postgres';
import type { HealthServer } from '../health/server';
import type { ReleaseProcessLock } from './process-lock';
import { awaitTracingShutdown } from './tracing-shutdown';

type Logger = Pick<typeof coreLogger, 'debug' | 'info' | 'warn' | 'error'>;

let shutdownInProgress = false;

export async function shutdownApplication({
  signal,
  client,
  db,
  healthServer,
  releaseProcessLock,
  shutdownTracing,
  stopRadio,
  log,
  exit = process.exit,
  tracingShutdownTimeoutMs = 1000
}: {
  signal: 'SIGTERM' | 'SIGINT';
  client: Client;
  db: PostgresAdapter;
  healthServer: HealthServer;
  releaseProcessLock: ReleaseProcessLock | null;
  shutdownTracing: () => Promise<void>;
  stopRadio?: () => Promise<void>;
  log: Logger;
  exit?: (code?: number) => never;
  tracingShutdownTimeoutMs?: number;
}): Promise<void> {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  log.info(`Received ${signal}, shutting down application`);

  try {
    const tracingShutdownOutcome = await awaitTracingShutdown({
      shutdownTracing,
      timeoutMs: tracingShutdownTimeoutMs
    });
    if (tracingShutdownOutcome === 'timed_out') {
      log.warn('Tracing shutdown timed out during application shutdown', {
        tracingShutdownTimeoutMs
      });
    }
  } catch (error) {
    log.warn('Failed to flush Langfuse traces during shutdown', error);
  }

  try {
    await healthServer.stop();
  } catch (error) {
    log.error('Failed to stop health server:', error);
  }

  try {
    await stopRadio?.();
  } catch (error) {
    log.error('Failed to stop radio playback during shutdown:', error);
  }

  try {
    client.destroy();
  } catch (error) {
    log.error('Failed to destroy Discord client:', error);
  }

  try {
    await db.disconnect();
  } catch (error) {
    log.error('Failed to disconnect database:', error);
  }

  try {
    releaseProcessLock?.();
  } catch (error) {
    log.warn('Failed to release process lock during shutdown', error);
  }

  exit(0);
}

export function resetShutdownStateForTests(): void {
  shutdownInProgress = false;
}
