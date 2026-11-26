import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceQuotaJournal } from '../../voice/quota-journal';

let directory: string;
const database = new URL('postgresql://fixture.invalid/silo');

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'silo-voice-quota-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('retries ambiguous acknowledgements for the same amount, then removes the journaled entry', async () => {
  const commit = mock(async (key: string, amount: number) => ({
    idempotencyKey: key,
    status: 'committed' as const,
    reservedAmount: 10,
    actualAmount: amount,
    usageDate: '2026-01-01',
    idempotent: true
  }));
  const original = new VoiceQuotaJournal(
    {
      commitQuotaUsage: async (key, amount) => {
        await commit(key, amount);
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
    new URL('postgresql://fixture.invalid/other'),
    directory
  );
  await otherTarget.flush(Date.now() + 61_000);
  expect(commit).toHaveBeenCalledTimes(1);

  const restarted = new VoiceQuotaJournal({ commitQuotaUsage: commit }, 'app', database, directory);
  await restarted.flush(Date.now() + 61_000);
  await restarted.flush(Date.now() + 61_000);

  expect(commit.mock.calls).toEqual([
    ['voice-reservation', 2],
    ['voice-reservation', 2]
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
