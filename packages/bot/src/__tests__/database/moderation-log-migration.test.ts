import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('content moderation failure action migration', () => {
  test('allows fail-closed decisions without weakening hashed moderation auditing', () => {
    const migration = readFileSync(
      resolve(
        import.meta.dir,
        '../../../../../supabase/migrations/026_content_moderation_failure_action.sql'
      ),
      'utf8'
    );

    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS content_moderation_log_action_taken_check'
    );
    expect(migration).toContain(
      "CHECK (action_taken IN ('allowed', 'blocked', 'warned', 'api_error_fail_closed'))"
    );
    expect(migration).not.toMatch(/\b(?:DELETE|TRUNCATE)\s+(?:FROM\s+)?content_moderation_log\b/i);
  });
});
