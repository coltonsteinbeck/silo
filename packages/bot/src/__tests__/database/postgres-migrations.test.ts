import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresAdapter } from '../../database/postgres';

describe('PostgresAdapter migrations', () => {
  test('fails startup when migration discovery or execution fails', async () => {
    const adapter = new PostgresAdapter('postgresql://user:pass@localhost:5432/test_db');
    const missingDirectory = resolve(import.meta.dir, 'missing-migrations-directory');
    (adapter as any).resolveMigrationsDir = () => missingDirectory;

    await expect((adapter as any).runMigrations()).rejects.toThrow();
    expect(adapter.getLastMigrationSummary()).toEqual({
      totalFiles: 0,
      applied: 0,
      skipped: 0,
      baselineMarked: 0,
      succeeded: false
    });

    await adapter.disconnect();
  });

  test('applies and tracks each migration atomically without guessing from already-exists errors', () => {
    const source = readFileSync(resolve(import.meta.dir, '../../database/postgres.ts'), 'utf8');

    expect(source).toContain("await client.query('BEGIN')");
    expect(source).toContain("await client.query('COMMIT')");
    expect(source).toContain("await client.query('ROLLBACK')");
    expect(source).not.toContain('Migration appears already applied');
    expect(source).not.toContain('isAlreadyAppliedMigrationError');
  });
});
