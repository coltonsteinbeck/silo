import { describe, expect, mock, test } from 'bun:test';
import { QuotaReservationReconciler } from '../../middleware/quota-reconciler';

describe('QuotaReservationReconciler', () => {
  test('runs a bounded batch and reads aggregate backlog only', async () => {
    const reconcileQuotaUsageReservations = mock(async () => ({
      processed: 1,
      committed: 1,
      released: 0,
      failed: 0
    }));
    const getQuotaReservationBacklog = mock(async () => ({
      reserved: 0,
      attempted: 0,
      staleAttempted: 0,
      oldestAttemptedSeconds: 0
    }));
    const reconciler = new QuotaReservationReconciler({
      reconcileQuotaUsageReservations,
      getQuotaReservationBacklog
    } as any);
    await reconciler.runOnce();
    expect(reconcileQuotaUsageReservations).toHaveBeenCalledWith(100);
    expect(getQuotaReservationBacklog).toHaveBeenCalledTimes(1);
  });

  test('does not overlap batches', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => {
      finish = resolve;
    });
    const reconcileQuotaUsageReservations = mock(async () => {
      await pending;
      return { processed: 0, committed: 0, released: 0, failed: 0 };
    });
    const reconciler = new QuotaReservationReconciler({
      reconcileQuotaUsageReservations,
      getQuotaReservationBacklog: async () => ({
        reserved: 0,
        attempted: 0,
        staleAttempted: 0,
        oldestAttemptedSeconds: 0
      })
    } as any);
    const first = reconciler.runOnce();
    await reconciler.runOnce();
    expect(reconcileQuotaUsageReservations).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});
