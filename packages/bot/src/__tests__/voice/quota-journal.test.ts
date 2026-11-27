import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceQuotaJournal } from '../../voice/quota-journal';

let directory: string;
const database = 'silo-fixture-database';
const recoverVoiceQuotaStart = async () => false;

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
      recoverVoiceQuotaStart,
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
    { commitQuotaUsage: commit, recoverVoiceQuotaStart },
    'app',
    'other-database',
    directory
  );
  await otherTarget.flush(Date.now() + 61_000);
  expect(commit).toHaveBeenCalledTimes(1);

  const restarted = new VoiceQuotaJournal(
    { commitQuotaUsage: commit, recoverVoiceQuotaStart },
    'app',
    database,
    directory
  );
  await restarted.flush(Date.now() + 61_000);
  await restarted.flush(Date.now() + 61_000);

  expect(commit.mock.calls).toEqual([
    ['voice-reservation', 2, 5_000],
    ['voice-reservation', 2, 5_000]
  ]);
});

test('failed abandoned starts back off so later reservations are recovered', async () => {
  const blocked = Array.from({ length: 25 }, (_, index) => `blocked-${index}`);
  const recover = mock(async (key: string, _minutes: number) => {
    if (key === blocked[0]) throw new Error('temporary database failure');
    return key === 'recoverable';
  });
  const store = { commitQuotaUsage: mock(), recoverVoiceQuotaStart: recover };
  const original = new VoiceQuotaJournal(store, 'app', database, directory);
  for (const key of [...blocked, 'recoverable']) original.begin(key);

  const restarted = new VoiceQuotaJournal(store, 'app', database, directory);
  const now = Date.now();
  await restarted.flush(now);
  expect(recover.mock.calls.map(([key]) => key)).toEqual(blocked);

  recover.mockClear();
  await restarted.flush(now);
  expect(recover.mock.calls).toEqual([['recoverable', 0]]);

  recover.mockClear();
  await restarted.flush(now + 65_000);
  expect(recover.mock.calls.map(([key]) => key)).toEqual(blocked);
});

test('rejects a journal directory that is open to other accounts', () => {
  chmodSync(directory, 0o755);
  const journal = new VoiceQuotaJournal(
    {
      recoverVoiceQuotaStart,
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

test('a failed identity read blocks voice until a later refresh succeeds', async () => {
  let attempts = 0;
  const resolveDatabaseId = mock(async () => {
    if (++attempts === 1)
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return database;
  });
  const journal = new VoiceQuotaJournal(
    {
      recoverVoiceQuotaStart,
      commitQuotaUsage: async () => {
        throw new Error('unexpected settlement');
      }
    },
    'app',
    resolveDatabaseId,
    directory
  );

  await journal.flush();
  expect(() => journal.assertReady()).toThrow('Voice quota database identity is unavailable');
  await Bun.sleep(0);
  expect(resolveDatabaseId).toHaveBeenCalledTimes(2);
  expect(() => journal.assertReady()).not.toThrow();
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
  const journal = new VoiceQuotaJournal(
    { commitQuotaUsage: commit, recoverVoiceQuotaStart },
    'app',
    database,
    directory
  );
  journal.assertReady();
  journal.begin('voice-reservation');
  journal.authorize('voice-reservation', 10);
  chmodSync(directory, 0o755);
  journal.record('voice-reservation', 2);
  await journal.flush();
  expect(commit).toHaveBeenCalledTimes(1);

  chmodSync(directory, 0o700);
  await journal.flush();
  expect(commit).toHaveBeenCalledTimes(2);
  databaseAvailable = true;
  const restarted = new VoiceQuotaJournal(
    { commitQuotaUsage: commit, recoverVoiceQuotaStart },
    'app',
    database,
    directory
  );
  await restarted.flush(Date.now() + 61_000);
  expect(commit.mock.calls[2]).toEqual(['voice-reservation', 2, 5_000]);
});

test('lease loss hands off only the measurement from this runtime’s admitted session', () => {
  const journal = new VoiceQuotaJournal(
    { commitQuotaUsage: mock(), recoverVoiceQuotaStart },
    'app',
    database,
    directory
  );
  journal.begin('owned');
  journal.authorize('owned', 10);
  chmodSync(directory, 0o755);
  journal.record('unknown', 5);
  journal.record('owned', 2);
  const settle = mock();
  journal.finishOnLeaseLoss(settle);
  expect(settle.mock.calls).toEqual([[[['owned', 2]]]]);
});

test('lease loss includes measured sessions beyond the normal replay batch', () => {
  const journal = new VoiceQuotaJournal(
    { commitQuotaUsage: mock(), recoverVoiceQuotaStart },
    'app',
    database,
    directory
  );
  const measurements = Array.from({ length: 26 }, (_, index): [string, number] => [
    `owned-${index}`,
    2
  ]);
  for (const [key] of measurements) journal.begin(key);
  chmodSync(directory, 0o755);
  for (const [key, amount] of measurements) journal.record(key, amount);
  const settle = mock();
  journal.finishOnLeaseLoss(settle);
  expect(settle.mock.calls).toEqual([[measurements]]);
});

test('an unwritable journal cannot override its first measurement with an unverified amount', async () => {
  const commitQuotaUsage = mock(async (key: string, amount: number) => ({
    idempotencyKey: key,
    status: 'committed' as const,
    reservedAmount: 10,
    actualAmount: amount,
    usageDate: '2026-01-01',
    idempotent: false
  }));
  const journal = new VoiceQuotaJournal(
    { commitQuotaUsage, recoverVoiceQuotaStart },
    'app',
    database,
    directory
  );
  journal.record('existing', 2);
  chmodSync(directory, 0o755);
  journal.record('existing', 3);
  await journal.flush();
  expect(commitQuotaUsage).not.toHaveBeenCalled();
  chmodSync(directory, 0o700);
  await journal.flush();
  expect(commitQuotaUsage.mock.calls.map(([key, amount]) => [key, amount])).toEqual([
    ['existing', 2]
  ]);
});
