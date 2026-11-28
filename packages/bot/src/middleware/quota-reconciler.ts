import { logger } from '@silo/core';
import type { AdminAdapter } from '../database/admin-adapter';

type QuotaReconciliationStore = Pick<
  AdminAdapter,
  'reconcileQuotaUsageReservations' | 'getQuotaReservationBacklog'
>;

/** Bounded, nonoverlapping recovery for expired reservation outcomes. */
export class QuotaReservationReconciler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly store: QuotaReconciliationStore) {}

  start(signal: AbortSignal): void {
    if (this.interval || signal.aborted) return;
    signal.addEventListener('abort', () => this.stop(), { once: true });
    void this.runOnce();
    this.interval = setInterval(() => void this.runOnce(), 15 * 60 * 1000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const settled = await this.store.reconcileQuotaUsageReservations(100);
      const backlog = await this.store.getQuotaReservationBacklog();
      const summary = {
        event: 'quota_reservation_reconciliation',
        ...settled,
        ...backlog
      };
      if (settled.failed > 0 || backlog.staleAttempted > 0) {
        logger.error('Quota reservation settlement needs review', summary);
      } else if (settled.processed > 0 || backlog.attempted > 0) {
        logger.info('Quota reservation settlement', summary);
      }
    } catch (error) {
      logger.error('Quota reservation reconciliation failed', {
        event: 'quota_reservation_reconciliation_failed',
        errorType: error instanceof Error ? error.name : 'unknown'
      });
    } finally {
      this.running = false;
    }
  }
}
