import fs from 'node:fs';
import path from 'node:path';
import type { logger as coreLogger } from '@silo/core';

type Logger = Pick<typeof coreLogger, 'debug' | 'info' | 'warn' | 'error'>;

export type ReleaseProcessLock = () => void;

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return typeof maybeCode === 'string' ? maybeCode : undefined;
}

function cleanupTempLockFile(lockFile: string): void {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // Ignore best-effort cleanup errors.
  }
}

function replaceStaleLock({
  lockFile,
  pid,
  existingPid,
  log,
  isProcessAlive
}: {
  lockFile: string;
  pid: number;
  existingPid: number;
  log: Logger;
  isProcessAlive: (pid: number) => boolean;
}): boolean | null {
  if (isProcessAlive(existingPid)) {
    log.error(`Another bot instance (PID ${existingPid}) is already running.`);
    return null;
  }

  const tempLockFile = `${lockFile}.${pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempLockFile, pid.toString(), { flag: 'wx' });

  try {
    fs.renameSync(tempLockFile, lockFile);
    log.info(`Process lock acquired (PID ${pid}) after stale lock cleanup`);
    return true;
  } catch (error) {
    cleanupTempLockFile(tempLockFile);
    if (getErrorCode(error) !== 'EEXIST') {
      throw error;
    }

    const currentPid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
    if (!Number.isNaN(currentPid) && currentPid !== pid && isProcessAlive(currentPid)) {
      log.error(`Another bot instance (PID ${currentPid}) is already running.`);
      return null;
    }

    return false;
  }
}

export function acquireProcessLock({
  cwd = process.cwd(),
  env = process.env,
  pid = process.pid,
  log,
  isProcessAlive = defaultIsProcessAlive
}: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  pid?: number;
  log: Logger;
  isProcessAlive?: (pid: number) => boolean;
}): ReleaseProcessLock | null {
  if (env.PM2_HOME || env.PM_ID !== undefined) {
    log.info('Running under PM2; skipping process lock');
    return () => {};
  }

  if (env.DEPLOYMENT_MODE === 'production' || env.NODE_ENV === 'production') {
    log.info('Production mode detected; skipping process lock');
    return () => {};
  }

  const lockFile = path.join(cwd, '.bot.lock');

  try {
    try {
      fs.writeFileSync(lockFile, pid.toString(), { flag: 'wx' });
      log.info(`Process lock acquired (PID ${pid})`);
    } catch (error: unknown) {
      if (getErrorCode(error) !== 'EEXIST') {
        throw error;
      }

      const content = fs.readFileSync(lockFile, 'utf-8').trim();
      const existingPid = parseInt(content, 10);

      if (!Number.isNaN(existingPid) && existingPid !== pid) {
        const replacedStaleLock = replaceStaleLock({
          lockFile,
          pid,
          existingPid,
          log,
          isProcessAlive
        });

        if (replacedStaleLock === null) {
          return null;
        }

        if (!replacedStaleLock) {
          log.error('Failed to replace stale process lock atomically');
          return null;
        }
      }
    }

    const release = () => {
      try {
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
        }
      } catch {
        // Ignore best-effort cleanup errors during process exit.
      }
    };

    process.on('exit', release);
    return release;
  } catch (error) {
    log.error('Failed to acquire process lock', error);
    return null;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (getErrorCode(error) === 'ESRCH') {
      return false;
    }
    throw error;
  }
}
