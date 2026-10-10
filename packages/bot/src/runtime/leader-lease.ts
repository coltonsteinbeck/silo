import { createHash } from 'node:crypto';
import type { Client } from 'pg';

const HEARTBEAT_MS = 5000;
const QUERY_TIMEOUT_MS = 5000;

// Session ownership requires a direct connection or a session-mode pooler.
export class RuntimeLeaderLease {
  private held = false;
  private closed = false;
  private released = false;
  private verification: Promise<boolean> | undefined;
  private lastConfirmed = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly key: string;

  private constructor(
    private readonly client: Client,
    applicationId: string,
    private readonly onLost: () => void
  ) {
    this.key = createHash('sha256')
      .update(`silo:runtime:${applicationId}`)
      .digest()
      .readBigInt64BE()
      .toString();
    client.on('error', this.lose);
    client.on('end', this.lose);
  }

  static async acquire(
    client: Client,
    applicationId: string,
    onLost: () => void
  ): Promise<RuntimeLeaderLease> {
    if (!applicationId.trim()) throw new Error('Runtime leader lease requires an application ID');
    const lease = new RuntimeLeaderLease(client, applicationId, onLost);
    try {
      await client.connect();
      const query = {
        text: 'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        values: [lease.key],
        query_timeout: QUERY_TIMEOUT_MS
      };
      const result = await client.query<{ acquired: boolean }>(query);
      if (lease.closed || result.rows[0]?.acquired !== true) {
        throw new Error('Runtime leader lease unavailable; another instance may be running');
      }
      lease.lastConfirmed = performance.now();
      lease.held = true;
      lease.heartbeat = setInterval(() => {
        if (!lease.isHeld()) lease.lose();
        else void lease.verify();
      }, HEARTBEAT_MS);
      lease.heartbeat.unref();
      return lease;
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
  }

  isHeld(): boolean {
    return this.held && performance.now() - this.lastConfirmed < HEARTBEAT_MS + QUERY_TIMEOUT_MS;
  }

  async verify(): Promise<boolean> {
    if (!this.isHeld()) {
      this.lose();
      return false;
    }
    if (this.verification) return this.verification;
    this.verification = this.checkOwnership();
    try {
      return await this.verification;
    } finally {
      this.verification = undefined;
    }
  }

  private async checkOwnership(): Promise<boolean> {
    try {
      const query = {
        text: `SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
            AND classid = (($1::bigint >> 32) & 4294967295)::oid
            AND objid = ($1::bigint & 4294967295)::oid AND objsubid = 1
        ) AS held`,
        values: [this.key],
        query_timeout: QUERY_TIMEOUT_MS
      };
      const result = await this.client.query<{ held: boolean }>(query);
      if (!this.isHeld() || result.rows[0]?.held !== true) {
        this.lose();
        return false;
      }
      this.lastConfirmed = performance.now();
      return true;
    } catch {
      this.lose();
      return false;
    }
  }

  private lose = (): void => {
    const wasHeld = this.held;
    this.held = false;
    this.closed = true;
    clearInterval(this.heartbeat);
    if (wasHeld) this.onLost();
  };

  async release(): Promise<void> {
    this.held = false;
    clearInterval(this.heartbeat);
    // Close the dedicated session; never return a locked connection to the pool.
    if (!this.released) {
      this.released = true;
      this.closed = true;
      await this.client.end();
    }
  }
}
