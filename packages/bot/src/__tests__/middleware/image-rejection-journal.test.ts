import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminAdapter } from '../../database/admin-adapter';
import { ImageRejectionJournal } from '../../middleware/image-rejection-journal';

test('replays a retained rejection after a database outage and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'silo-image-rejection-'));
  const identity = async () => 'fixture-database';
  const evidence = {
    provider: 'openai',
    status: 404,
    code: 'model_not_found',
    requestId: 'req_test'
  } as const;
  const release = mock<AdminAdapter['releaseRejectedImageQuotaUsage']>(async key => ({
    idempotencyKey: key,
    status: 'released' as const,
    reservedAmount: 1,
    actualAmount: null,
    usageDate: '2026-01-01',
    idempotent: false
  }));
  try {
    const original = new ImageRejectionJournal(
      {
        releaseRejectedImageQuotaUsage: async () => {
          throw new Error('database unavailable');
        }
      },
      'app',
      identity,
      directory
    );
    await original.record('rejection', 'guild', 'member', evidence);
    await original.flush();
    const restarted = new ImageRejectionJournal(
      { releaseRejectedImageQuotaUsage: release },
      'app',
      identity,
      directory
    );
    await restarted.flush(Date.now() + 61_000);
    await restarted.flush(Date.now() + 61_000);
    expect(release.mock.calls).toEqual([
      [
        'rejection',
        'guild',
        'member',
        { status: 404, code: 'model_not_found', requestId: 'req_test' }
      ]
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
