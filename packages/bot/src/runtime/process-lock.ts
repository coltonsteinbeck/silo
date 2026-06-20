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

function readLockPid(lockFile: string): number | null {
  try {
    const content = fs.readFileSync(lockFile, 'utf-8').trim();
    const parsedPid = parseInt(content, 10);
    return Number.isNaN(parsedPid) ? null : parsedPid;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function writeLockFileExclusive(lockFile: string, pid: number): boolean {
  try {
    fs.writeFileSync(lockFile, pid.toString(), { flag: 'wx' });
    return true;
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      return false;
    }

    throw error;
  }
}

function removeLockFile(lockFile: string): void {
  try {
    fs.rmSync(lockFile);
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
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
  existingPid: number | null;
  log: Logger;
  isProcessAlive: (pid: number) => boolean;
}): boolean | null {
  if (existingPid !== null && isProcessAlive(existingPid)) {
    log.error(`Another bot instance (PID ${existingPid}) is already running.`);
    return null;
  }

  let stalePid = existingPid;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    removeLockFile(lockFile);

    if (writeLockFileExclusive(lockFile, pid)) {
      log.info(`Process lock acquired (PID ${pid}) after stale lock cleanup`);
      return true;
    }

    const currentPid = readLockPid(lockFile);
    if (currentPid !== null && currentPid !== pid && isProcessAlive(currentPid)) {
      log.error(`Another bot instance (PID ${currentPid}) is already running.`);
      return null;
    }

    stalePid = currentPid;
    if (stalePid !== null && isProcessAlive(stalePid)) {
      log.error(`Another bot instance (PID ${stalePid}) is already running.`);
      return null;
    }
  }

  return false;
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
    const acquiredLock = writeLockFileExclusive(lockFile, pid);
    if (acquiredLock) {
      log.info(`Process lock acquired (PID ${pid})`);
    } else {
      const existingPid = readLockPid(lockFile);

      if (existingPid !== pid) {
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
        const lockOwnerPid = readLockPid(lockFile);
        if (lockOwnerPid === pid) {
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
