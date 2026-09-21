import { spawnSync } from 'node:child_process';
import path from 'node:path';

interface HygieneViolation {
  file: string;
  reason: string;
}

const allowedArtifactPaths = new Set([
  'packages/bot/src/__tests__/fixtures/conversation-output-safety.csv',
  'docker/postgres-init/000_supabase_compat.sql'
]);

const blockedDirectoryReasons = new Map([
  ['logs', 'runtime logs must not be committed'],
  ['incidents', 'incident artifacts must not be committed'],
  ['backups', 'backups must not be committed'],
  ['exports', 'data exports must not be committed'],
  ['dumps', 'data dumps must not be committed'],
  ['filedump', 'local data dumps must not be committed'],
  ['.claude', 'local agent scaffolding is not part of this repo surface']
]);

const blockedDataArtifactPattern =
  /(?:\.csv|\.tsv|\.dump|\.backup|\.sql|\.sql\.gz|\.jsonl|\.ndjson|\.parquet|\.sqlite|\.sqlite3|\.db)$/i;

function listGitVisibleFiles(): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      encoding: 'utf8'
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || 'Failed to list repository files');
  }

  return result.stdout.split('\0').filter(Boolean);
}

export function findRepoHygieneViolations(files: string[]): HygieneViolation[] {
  const violations: HygieneViolation[] = [];

  for (const file of files) {
    const normalized = file.split(path.sep).join('/');
    const basename = path.posix.basename(normalized);

    if (basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.example')) {
      violations.push({ file: normalized, reason: 'environment files must stay local' });
      continue;
    }

    if (/^\.[a-z][a-z0-9-]*-local(?:\/|$)/i.test(normalized)) {
      violations.push({
        file: normalized,
        reason: 'private workflow bundles must not be committed'
      });
      continue;
    }

    const blockedDirectory = normalized
      .split('/')
      .map(segment => segment.toLowerCase())
      .find(segment => blockedDirectoryReasons.has(segment));
    if (blockedDirectory) {
      violations.push({
        file: normalized,
        reason: blockedDirectoryReasons.get(blockedDirectory) as string
      });
      continue;
    }

    if (allowedArtifactPaths.has(normalized)) {
      continue;
    }

    if (blockedDataArtifactPattern.test(basename)) {
      if (normalized.startsWith('supabase/migrations/') && /\.sql$/i.test(basename)) {
        continue;
      }

      violations.push({
        file: normalized,
        reason: 'data exports, database dumps, and backups must not be committed'
      });
      continue;
    }

    if (/\.log(?:\.\d+)?$/i.test(basename) || /^pm2-(?:out|error)/i.test(basename)) {
      violations.push({ file: normalized, reason: 'log files must not be committed' });
    }
  }

  return violations;
}

function main(): void {
  const violations = findRepoHygieneViolations(listGitVisibleFiles());

  if (violations.length === 0) {
    console.info('Repo hygiene check passed.');
    return;
  }

  console.error('Repo hygiene check failed:');
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.reason}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  main();
}
