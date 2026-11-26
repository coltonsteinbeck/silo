import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceQuotaJournal } from '../../voice/quota-journal';

let directory: string;
const database = 'silo-fixture-database';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'silo-voice-quota-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('retries ambiguous acknowledgements for the same amount, then removes the journaled entry', async () => {
  const commit = mock(async (key: string, amount: number, _timeout?: number) => ({
    idempotencyKey: key,
    status: 'committed' as const,
    reservedAmount: 10,
    actualAmount: amount,
    usageDate: '2026-01-01',
    idempotent: true
  }));
  const original = new VoiceQuotaJournal(
    {
      commitQuotaUsage: async (key, amount, timeout) => {
        await commit(key, amount, timeout);
        throw new Error('acknowledgement lost');
      }
    },
    'app',
    database,
    directory
  );
  original.record('voice-reservation', 2);
  original.record('voice-reservation', 2);
  expect(() => original.record('voice-reservation', 3)).toThrow('Conflicting');
  await original.flush();

  const otherTarget = new VoiceQuotaJournal(
    { commitQuotaUsage: commit },
    'app',
    'other-database',
    directory
  );
  await otherTarget.flush(Date.now() + 61_000);
  expect(commit).toHaveBeenCalledTimes(1);

  const restarted = new VoiceQuotaJournal({ commitQuotaUsage: commit }, 'app', database, directory);
  await restarted.flush(Date.now() + 61_000);
  await restarted.flush(Date.now() + 61_000);

  expect(commit.mock.calls).toEqual([
    ['voice-reservation', 2, 5_000],
    ['voice-reservation', 2, 5_000]
  ]);
});

test('rejects a journal directory that is open to other accounts', () => {
  chmodSync(directory, 0o755);
  const journal = new VoiceQuotaJournal(
    {
      commitQuotaUsage: async () => {
        throw new Error('unexpected settlement');
      }
    },
    'app',
    database,
    directory
  );
  expect(() => journal.assertReady()).toThrow('must be private');
});

test('retains the measurement when the journal and database are temporarily unavailable', async () => {
  let databaseAvailable = false;
  const commit = mock(async (key: string, amount: number, _timeout?: number) => {
    if (!databaseAvailable) throw new Error('database unavailable');
    return {
      idempotencyKey: key,
      status: 'committed' as const,
      reservedAmount: 10,
      actualAmount: amount,
      usageDate: '2026-01-01',
      idempotent: false
    };
  });
  const journal = new VoiceQuotaJournal({ commitQuotaUsage: commit }, 'app', database, directory);
  journal.assertReady();
  chmodSync(directory, 0o755);
  journal.record('voice-reservation', 2);
  await journal.flush();
  expect(commit).toHaveBeenCalledTimes(1);

  chmodSync(directory, 0o700);
  await journal.flush();
  expect(commit).toHaveBeenCalledTimes(2);
  databaseAvailable = true;
  const restarted = new VoiceQuotaJournal({ commitQuotaUsage: commit }, 'app', database, directory);
  await restarted.flush(Date.now() + 61_000);
  expect(commit.mock.calls[2]).toEqual(['voice-reservation', 2, 5_000]);
});
