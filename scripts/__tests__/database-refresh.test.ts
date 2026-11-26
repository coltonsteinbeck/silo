import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, expect } from 'bun:test';

const script = new URL('../refresh-prod-to-branch.sh', import.meta.url).pathname;
const marker = 'synthetic-confidential-row';

test.each(['success', 'partial', 'cancelled'])(
  'refresh %s publishes only status and keeps database output private',
  scenario => {
    const root = mkdtempSync(join(tmpdir(), 'silo-refresh-test-'));
    try {
      const dump = join(root, 'pg_dump');
      const psql = join(root, 'psql');
      writeFileSync(
        dump,
        `#!/bin/bash
if [ "$1" = --version ]; then echo 'pg_dump (PostgreSQL) 16.11'; exit 0; fi
while [ "$1" != --file ] && [ "$#" -gt 0 ]; do shift; done
[ "$#" -ge 2 ] || exit 2
printf '%s\\n' '${marker}' > "$2"
echo '${marker}' >&2
if [ "$REFRESH_TEST_SCENARIO" = partial ] && [[ "$2" == *selected-data.sql ]]; then exit 1; fi
if [ "$REFRESH_TEST_SCENARIO" = cancelled ]; then kill -TERM "$PPID"; fi
`
      );
      writeFileSync(
        psql,
        `#!/bin/bash
if [[ "$*" == *server_version_num* ]]; then echo '160011'; fi
echo '${marker}' >&2
`
      );
      chmodSync(dump, 0o700);
      chmodSync(psql, 0o700);

      const result = Bun.spawnSync(['bash', script], {
        env: {
          PATH: [root, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
          REFRESH_ENV_FILE: join(root, 'unused'),
          REFRESH_TEST_SCENARIO: scenario,
          PROD_DB_URL: 'postgresql://source.example.test/synthetic',
          BRANCH_DB_URL: 'postgresql://destination.example.test/synthetic',
          CONFIRM_REMOTE_RESTORE: 'true',
          CHECK_MIGRATION_COMPATIBILITY: 'false',
          BACKUP_DIR: root,
          INCLUDE_TABLES: 'public.fixture',
          TRUNCATE_TARGET: 'true'
        }
      });
      expect(result.stdout.toString().trim()).toBe(
        scenario === 'success' ? '{"status":"passed"}' : '{"status":"failed"}'
      );
      expect(result.stderr.toString()).not.toContain(marker);
      expect(result.exitCode === 0).toBe(scenario === 'success');
      const run = readdirSync(root).find(name => name.startsWith('silo-refresh.'));
      expect(run).toBeDefined();
      const directory = join(root, run!);
      expect(readFileSync(join(directory, 'refresh.log'), 'utf8')).toContain(marker);
      expect(readdirSync(directory)).not.toContain('prod-full.dump');
      if (scenario === 'success') {
        expect(readFileSync(join(directory, 'truncate-selected.sql'), 'utf8')).toBe(
          'TRUNCATE TABLE ONLY "public"."fixture";\n'
        );
        expect(readFileSync(join(directory, 'target-before-refresh.dump'), 'utf8')).toContain(
          marker
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);
