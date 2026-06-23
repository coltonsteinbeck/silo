import { spawnSync } from 'node:child_process';
import path from 'node:path';

interface HygieneViolation {
  file: string;
  reason: string;
}

const blockedPathPrefixes = [
  { prefix: 'logs/', reason: 'runtime logs must not be committed' },
  { prefix: 'fileDump/', reason: 'local data dumps must not be committed' },
  { prefix: '.claude/', reason: 'Claude scaffolding is not part of this repo surface' }
];

function listGitVisibleFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8'
  });

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

    if (normalized === '.env' || /^\.env\.(?!example$).+/.test(normalized)) {
      violations.push({ file: normalized, reason: 'environment files must stay local' });
      continue;
    }

    if (normalized === '.claude') {
      violations.push({ file: normalized, reason: 'Claude scaffolding is not part of this repo surface' });
      continue;
    }

    const blockedPrefix = blockedPathPrefixes.find(({ prefix }) => normalized.startsWith(prefix));
    if (blockedPrefix) {
      violations.push({ file: normalized, reason: blockedPrefix.reason });
      continue;
    }

    if (/^conversation_messages_rows.*\.csv$/i.test(basename)) {
      violations.push({
        file: normalized,
        reason: 'exported Discord conversation CSVs must not be committed'
      });
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
