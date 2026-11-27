import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { logger } from '@silo/core';
import type { ClientConfig } from 'pg';
import type { AdminAdapter } from '../database/admin-adapter';

const RETRY_INTERVAL_MS = 60_000;
const COMMIT_TIMEOUT_MS = 5_000;
const REPLAY_BATCH_SIZE = 25;

class ConflictingMeasurement extends Error {}

export class VoiceQuotaJournal {
  private path?: string;
  private readonly unjournaled = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly ownedMeasurements = new Set<string>();
  private draining = false;

  constructor(
    private readonly store: Pick<AdminAdapter, 'commitQuotaUsage' | 'recoverVoiceQuotaStart'>,
    private readonly applicationId: string,
    private readonly databaseId: string | (() => Promise<string>),
    private readonly directory = process.env.SILO_VOICE_QUOTA_DIRECTORY ??
      join(homedir(), '.local', 'state', 'silo', 'voice-quota')
  ) {
    if (typeof databaseId === 'string') this.path = this.pathFor(databaseId);
  }

  private pathFor(databaseId: string): string {
    const namespace = createHash('sha256')
      .update(JSON.stringify([this.applicationId, databaseId]))
      .digest('hex');
    return join(this.directory, `${namespace}.sqlite`);
  }

  private open(): Database {
    const path = this.path;
    if (!path) throw new Error('Voice quota database identity is unavailable');
    const directory = dirname(path);
    if (!isAbsolute(directory)) throw new Error('Voice quota directory must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error('Voice quota directory must be private to the bot account');
    }
    const file = lstatSync(path, { throwIfNoEntry: false });
    if (file && (!file.isFile() || file.uid !== metadata.uid)) {
      throw new Error('Voice quota journal must be a regular file owned by the bot account');
    }
    const db = new Database(path, { strict: true });
    try {
      chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout = 1000');
      const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL').get();
      if (mode?.journal_mode !== 'wal') throw new Error('Voice quota journal requires WAL support');
      // A terminal measurement must survive process exit before the PostgreSQL write.
      db.exec('PRAGMA synchronous = FULL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS pending (
          reservation_key TEXT PRIMARY KEY NOT NULL,
          minutes INTEGER NOT NULL CHECK (minutes > 0),
          retry_at INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS voice_starts (
          reservation_key TEXT PRIMARY KEY NOT NULL,
          fallback_minutes INTEGER NOT NULL DEFAULT 0,
          recover_at INTEGER NOT NULL DEFAULT 0
        )
      `);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  assertReady(): void {
    if (!this.path) void this.flush();
    this.open().close();
  }

  begin(key: string): void {
    const db = this.open();
    try {
      const result = db.run(
        `INSERT INTO voice_starts (reservation_key)
         SELECT ? WHERE NOT EXISTS (SELECT 1 FROM pending WHERE reservation_key = ?)`,
        [key, key]
      );
      if (result.changes !== 1) throw new Error('Voice quota already has a terminal measurement');
      this.active.add(key);
    } finally {
      db.close();
    }
  }

  authorize(key: string, reservedMinutes: number): void {
    if (!this.active.has(key)) throw new Error('Voice quota start is no longer active');
    const db = this.open();
    try {
      const result = db.run(
        'UPDATE voice_starts SET fallback_minutes = ?, recover_at = ? WHERE reservation_key = ?',
        [reservedMinutes, Date.now() + reservedMinutes * 60_000 + RETRY_INTERVAL_MS, key]
      );
      if (result.changes !== 1) throw new Error('Voice quota start is missing');
    } finally {
      db.close();
    }
  }

  cancel(key: string): void {
    this.active.delete(key);
  }

  record(reservationKey: string, minutes: number): void {
    const retained = this.unjournaled.get(reservationKey);
    if (retained !== undefined && retained !== minutes) {
      throw new ConflictingMeasurement('Conflicting terminal voice quota amount');
    }
    if (this.active.delete(reservationKey)) this.ownedMeasurements.add(reservationKey);
    this.unjournaled.set(reservationKey, minutes);
    try {
      this.write(reservationKey, minutes);
      this.unjournaled.delete(reservationKey);
      this.ownedMeasurements.delete(reservationKey);
    } catch (error) {
      if (error instanceof ConflictingMeasurement) {
        this.unjournaled.delete(reservationKey);
        this.ownedMeasurements.delete(reservationKey);
        throw error;
      }
      logger.warn('Voice quota measurement is waiting for journal storage', {
        errorType: error instanceof Error ? error.name : 'unknown'
      });
    }
  }

  private write(reservationKey: string, minutes: number): void {
    const db = this.open();
    try {
      db.transaction(() => {
        const stored = db
          .query<{ minutes: number }, [string, number]>(
            `
        INSERT INTO pending (reservation_key, minutes) VALUES (?, ?)
        ON CONFLICT (reservation_key) DO UPDATE SET minutes = pending.minutes
        RETURNING minutes
      `
          )
          .get(reservationKey, minutes);
        if (stored?.minutes !== minutes) {
          throw new ConflictingMeasurement('Conflicting terminal voice quota amount');
        }
        db.run('DELETE FROM voice_starts WHERE reservation_key = ?', [reservationKey]);
      })();
    } finally {
      db.close();
    }
  }

  private async commit(key: string, minutes: number): Promise<void> {
    const result = await this.store.commitQuotaUsage(key, minutes, COMMIT_TIMEOUT_MS);
    if (
      result.idempotencyKey !== key ||
      result.status !== 'committed' ||
      result.actualAmount !== minutes
    ) {
      throw new Error('Unexpected voice quota settlement result');
    }
  }

  start(signal: AbortSignal): void {
    if (signal.aborted) return;
    void this.flush();
    const timer = setInterval(() => void this.flush(), RETRY_INTERVAL_MS);
    timer.unref();
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  }

  async flush(now = Date.now()): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let db: Database | undefined;
    try {
      if (!this.path) {
        const databaseId =
          typeof this.databaseId === 'function' ? await this.databaseId() : this.databaseId;
        this.path = this.pathFor(databaseId);
      }
      if (!this.unjournaled.size && !existsSync(this.path)) return;
      for (const [key, minutes] of [...this.unjournaled].slice(0, REPLAY_BATCH_SIZE)) {
        try {
          this.record(key, minutes);
          // Only this runtime's admitted sessions can settle without checking SQLite.
          if (this.unjournaled.has(key) && this.ownedMeasurements.has(key)) {
            await this.commit(key, minutes);
            this.unjournaled.delete(key);
            this.ownedMeasurements.delete(key);
          }
        } catch (error) {
          if (this.unjournaled.delete(key)) this.unjournaled.set(key, minutes);
          logger.warn('Unjournaled voice quota remains pending', {
            errorType: error instanceof Error ? error.name : 'unknown'
          });
        }
      }
      if (!existsSync(this.path)) return;
      db = this.open();
      const pending = db
        .query<{ reservation_key: string; minutes: number }, [number, number]>(
          `
        SELECT reservation_key, minutes FROM pending WHERE retry_at <= ?
        ORDER BY retry_at, rowid LIMIT ?
      `
        )
        .all(now, REPLAY_BATCH_SIZE);
      for (const { reservation_key: key, minutes } of pending) {
        try {
          await this.commit(key, minutes);
          db.run('DELETE FROM pending WHERE reservation_key = ? AND minutes = ?', [key, minutes]);
        } catch (error) {
          db.run('UPDATE pending SET retry_at = ? WHERE reservation_key = ?', [
            Date.now() + RETRY_INTERVAL_MS,
            key
          ]);
          logger.warn('Measured voice quota remains queued', {
            errorType: error instanceof Error ? error.name : 'unknown'
          });
        }
      }
      const abandoned = db
        .query<{ reservation_key: string; fallback_minutes: number }, [number, string, number]>(
          `SELECT reservation_key, fallback_minutes FROM voice_starts
           WHERE recover_at <= ?
             AND reservation_key NOT IN (SELECT value FROM json_each(?))
           ORDER BY recover_at, rowid LIMIT ?`
        )
        .all(now, JSON.stringify([...this.active, ...this.unjournaled.keys()]), REPLAY_BATCH_SIZE);
      for (const { reservation_key: key, fallback_minutes: minutes } of abandoned) {
        try {
          if (await this.store.recoverVoiceQuotaStart(key, minutes)) {
            db.run('DELETE FROM voice_starts WHERE reservation_key = ?', [key]);
          }
        } catch {
          logger.warn('Abandoned voice quota recovery will retry');
        }
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      logger.error(
        this.path
          ? 'Voice quota journal replay failed'
          : 'Voice quota database identity could not be loaded',
        {
          errorType: error instanceof Error ? error.name : 'unknown',
          errorCode: typeof code === 'string' && /^[A-Z0-9_]{2,32}$/.test(code) ? code : undefined
        }
      );
    } finally {
      db?.close();
      this.draining = false;
    }
  }

  finishOnLeaseLoss(settle: (measurements: [string, number][]) => void): void {
    const measurements = [...this.unjournaled]
      .filter(([key]) => this.ownedMeasurements.has(key))
      .slice(0, REPLAY_BATCH_SIZE);
    if (measurements.length) settle(measurements);
  }
}

export function settleVoiceQuotaOnLeaseLoss(
  config: Pick<ClientConfig, 'connectionString' | 'ssl'>,
  measurements: [string, number][]
): void {
  // Keep the bot event loop stopped until exit. The child can only settle quota.
  const driver = createRequire(import.meta.url).resolve('pg');
  const worker = `
    import pg from ${JSON.stringify(driver)};
    const { config, measurements } = await Bun.stdin.json();
    const client = new pg.Client({ ...config, connectionTimeoutMillis: 3000, query_timeout: 3000 });
    await client.connect();
    try {
      for (const [key, minutes] of measurements) {
        await client.query('SELECT public.commit_quota_usage($1, $2)', [key, minutes]);
      }
    } finally { await client.end(); }
  `;
  const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', worker], {
    stdin: Buffer.from(JSON.stringify({ config, measurements })),
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: COMMIT_TIMEOUT_MS,
    env: { PATH: process.env.PATH }
  });
  if (!result.success) logger.error('Voice quota settlement on lease loss could not be confirmed');
}
