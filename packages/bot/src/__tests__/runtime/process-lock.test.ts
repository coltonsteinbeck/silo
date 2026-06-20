import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireProcessLock } from '../../runtime/process-lock';

function createLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-lock-'));
  tempDirs.push(dir);
  return dir;
}

describe('process lock', () => {
  test('skips locking under PM2', () => {
    const dir = makeTempDir();
    const release = acquireProcessLock({
      cwd: dir,
      env: { PM_ID: '0' },
      pid: 123,
      log: createLogger()
    });

    expect(release).toBeFunction();
    expect(fs.existsSync(path.join(dir, '.bot.lock'))).toBe(false);
  });

  test('creates and releases a local lock', () => {
    const dir = makeTempDir();
    const release = acquireProcessLock({
      cwd: dir,
      env: {},
      pid: 123,
      log: createLogger()
    });

    const lockFile = path.join(dir, '.bot.lock');
    expect(release).toBeFunction();
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('123');

    release?.();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  test('cleans up stale locks', () => {
    const dir = makeTempDir();
    const lockFile = path.join(dir, '.bot.lock');
    fs.writeFileSync(lockFile, '999');

    const release = acquireProcessLock({
      cwd: dir,
      env: {},
      pid: 123,
      log: createLogger(),
      isProcessAlive: () => false
    });

    expect(release).toBeFunction();
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('123');
  });

  test('refuses lock when another process is alive', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, '.bot.lock'), '999');

    const release = acquireProcessLock({
      cwd: dir,
      env: {},
      pid: 123,
      log: createLogger(),
      isProcessAlive: () => true
    });

    expect(release).toBeNull();
  });

  test('does not release a lock owned by another process', () => {
    const dir = makeTempDir();
    const lockFile = path.join(dir, '.bot.lock');
    const release = acquireProcessLock({
      cwd: dir,
      env: {},
      pid: 123,
      log: createLogger()
    });

    fs.writeFileSync(lockFile, '456');
    release?.();

    expect(fs.readFileSync(lockFile, 'utf8')).toBe('456');
  });
});
