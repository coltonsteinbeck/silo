import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@silo/core';
import type { AdminAdapter } from '../database/admin-adapter';
import { openLocalQuotaJournal } from '../database/local-quota-journal';
import type { ImageModelRejectionEvidence } from '../providers/image-rejection';

const REPLAY_INTERVAL_MS = 60_000;

interface PendingRejection {
  key: string;
  guild: string;
  user: string;
  status: 400 | 404;
  request_id: string;
}

export class ImageRejectionJournal {
  private path?: string;
  private replaying = false;

  constructor(
    private readonly store: Pick<AdminAdapter, 'releaseRejectedImageQuotaUsage'>,
    private readonly applicationId: string,
    private readonly databaseId: () => Promise<string>,
    private readonly directory = process.env.SILO_VOICE_QUOTA_DIRECTORY ??
      join(homedir(), '.local', 'state', 'silo', 'voice-quota')
  ) {}

  private async resolvePath(): Promise<string> {
    if (!this.path) {
      const namespace = createHash('sha256')
        .update(JSON.stringify([this.applicationId, await this.databaseId()]))
        .digest('hex');
      this.path = join(this.directory, `image-rejections-${namespace}.sqlite`);
    }
    return this.path;
  }

  async record(
    key: string,
    guild: string,
    user: string,
    evidence: ImageModelRejectionEvidence
  ): Promise<void> {
    const db = openLocalQuotaJournal(await this.resolvePath());
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS rejections (
        key TEXT PRIMARY KEY, guild TEXT NOT NULL, user TEXT NOT NULL,
        status INTEGER NOT NULL, request_id TEXT NOT NULL, retry_at INTEGER NOT NULL DEFAULT 0
      )`);
      db.run(
        `INSERT INTO rejections (key, guild, user, status, request_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
        [key, guild, user, evidence.status, evidence.requestId]
      );
    } finally {
      db.close();
    }
  }

  start(signal: AbortSignal): void {
    if (signal.aborted) return;
    void this.flush();
    const timer = setInterval(() => void this.flush(), REPLAY_INTERVAL_MS);
    timer.unref();
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  }

  async flush(now = Date.now()): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    try {
      const path = await this.resolvePath();
      if (!existsSync(path)) return;
      const db = openLocalQuotaJournal(path);
      try {
        const pending = db
          .query<PendingRejection, [number]>(
            `SELECT key, guild, user, status, request_id FROM rejections
             WHERE retry_at <= ? ORDER BY retry_at, rowid LIMIT 25`
          )
          .all(now);
        for (const row of pending) {
          try {
            const result = await this.store.releaseRejectedImageQuotaUsage(
              row.key,
              row.guild,
              row.user,
              { status: row.status, code: 'model_not_found', requestId: row.request_id }
            );
            if (result.status !== 'released') throw new Error('Unconfirmed image quota release');
            db.run('DELETE FROM rejections WHERE key = ?', [row.key]);
          } catch {
            db.run('UPDATE rejections SET retry_at = ? WHERE key = ?', [
              Date.now() + REPLAY_INTERVAL_MS,
              row.key
            ]);
            logger.warn('Rejected image quota remains queued for release');
          }
        }
      } finally {
        db.close();
      }
    } catch {
      logger.warn('Image quota rejection journal could not replay');
    } finally {
      this.replaying = false;
    }
  }
}
