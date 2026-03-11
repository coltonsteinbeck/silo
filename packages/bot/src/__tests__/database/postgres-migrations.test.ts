import { describe, expect, test } from 'bun:test';
import { PostgresAdapter } from '../../database/postgres';

describe('PostgresAdapter migration error detection', () => {
  test('treats only explicit already-applied indicators as safe', async () => {
    const adapter = new PostgresAdapter('postgresql://user:pass@localhost:5432/test_db');
    const isAlreadyAppliedMigrationError = (adapter as any).isAlreadyAppliedMigrationError.bind(
      adapter
    ) as (error: unknown) => boolean;

    expect(isAlreadyAppliedMigrationError({ message: 'relation "foo" already exists' })).toBe(true);
    expect(isAlreadyAppliedMigrationError({ code: 'EEXIST' })).toBe(true);

    expect(isAlreadyAppliedMigrationError({ message: 'relation "foo" does not exist' })).toBe(
      false
    );
    expect(isAlreadyAppliedMigrationError({ message: 'permission denied' })).toBe(false);
    expect(isAlreadyAppliedMigrationError(null)).toBe(false);

    await adapter.disconnect();
  });
});
