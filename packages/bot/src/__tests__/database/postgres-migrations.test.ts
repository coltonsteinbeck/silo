import { describe, expect, mock, test } from 'bun:test';
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

  test('protects internal migration and ingress tables from Data API roles', () => {
    const adapterSource = readFileSync(
      resolve(import.meta.dir, '../../database/postgres.ts'),
      'utf8'
    );
    const migrationScript = readFileSync(
      resolve(import.meta.dir, '../../../../../scripts/migrate.sh'),
      'utf8'
    );
    for (const source of [adapterSource, migrationScript]) {
      expect(source).toContain(
        'ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY'
      );
      expect(source).toContain('REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC');
      expect(source).toContain('schema_migrations_backend_acl');
      for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
        expect(source).toContain(`'${role}'`);
      }
    }

    const followUpMigration = readFileSync(
      resolve(
        import.meta.dir,
        '../../../../../supabase/migrations/20261011210000_harden_internal_control_tables.sql'
      ),
      'utf8'
    );
    expect(followUpMigration).toContain(
      'ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY'
    );
    expect(followUpMigration).toContain(
      'ALTER TABLE public.assistant_message_ingress ENABLE ROW LEVEL SECURITY'
    );
    expect(followUpMigration).toContain('schema_migrations_backend_acl');
    expect(followUpMigration).toContain('assistant_message_ingress_backend_acl');
    for (const role of ['anon', 'authenticated', 'service_role', 'authenticator']) {
      expect(followUpMigration).toContain(`'${role}'`);
    }
  });

  test('a non-owner runtime verifies an installed tracker boundary without owner-only DDL', async () => {
    const query = mock(async (sql: string) => {
      if (sql.includes('SELECT pg_has_role')) {
        return { rows: [{ can_alter: false }], rowCount: 1 };
      }
      if (sql.includes('AS acl_policy')) {
        return {
          rows: [
            {
              row_security: true,
              api_roles_blocked: true,
              backend_select: true,
              backend_insert: true,
              backend_delete: false,
              acl_policy: true
            }
          ],
          rowCount: 1
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = new PostgresAdapter('postgresql://fixture:fixture@example.invalid/test_db');

    await expect((adapter as any).prepareMigrationTracker({ query })).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.map(call => String(call[0])).join('\n')).not.toContain(
      'ALTER TABLE public.schema_migrations'
    );

    await adapter.disconnect();
  });
});
