import type { Client } from 'discord.js';
import type { logger as coreLogger } from '@silo/core';
import type { PostgresAdapter } from '../database/postgres';
import type { HealthServer } from '../health/server';
import type { ReleaseProcessLock } from './process-lock';

type Logger = Pick<typeof coreLogger, 'debug' | 'info' | 'warn' | 'error'>;

let shutdownInProgress = false;

export async function shutdownApplication({
  signal,
  client,
  db,
  healthServer,
  releaseProcessLock,
  shutdownTracing,
  log,
  exit = process.exit
}: {
  signal: 'SIGTERM' | 'SIGINT';
  client: Client;
  db: PostgresAdapter;
  healthServer: HealthServer;
  releaseProcessLock: ReleaseProcessLock | null;
  shutdownTracing: () => Promise<void>;
  log: Logger;
  exit?: (code?: number) => never;
}): Promise<void> {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  log.info(`Received ${signal}, shutting down application`);

  try {
    await shutdownTracing();
  } catch (error) {
    log.warn('Failed to flush Langfuse traces during shutdown', error);
  }

  try {
    await healthServer.stop();
  } catch (error) {
    log.error('Failed to stop health server:', error);
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
