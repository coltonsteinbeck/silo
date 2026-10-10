import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../evals/run-langfuse-safety-evals.ts', import.meta.url));

test.each([
  'output.managed-dr-cock-title',
  'output.standard-dr-cock-title',
  'output.managed-explicit-still-blocked',
  'input.contextual-slur-analysis',
  'input.safe-rewrite-professionalize-slur',
  'input.quoted-abuse-report',
  'input.explicit-sex-technique',
  'input.direct-slur-generation-request'
])('evaluation CLI preserves the safety policy for %s', caseId => {
  const cwd = mkdtempSync(join(tmpdir(), 'safety-eval-runner-'));
  try {
    // Prevent discovery of a developer environment and all outbound requests.
    writeFileSync(join(cwd, '.env'), '');
    const preload = join(cwd, 'offline.ts');
    writeFileSync(
      preload,
      "globalThis.fetch = async () => { throw new Error('offline-eval-network-blocked'); };\n"
    );
    const result = spawnSync(
      process.execPath,
      ['--preload', preload, runner, `--case=${caseId}`, '--no-scores'],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          DISCORD_TOKEN: 'fixture'.repeat(10),
          DISCORD_CLIENT_ID: 'fixture',
          DATABASE_URL: 'fixture-database',
          OPENAI_GUARDRAILS_ENABLED: 'false',
          OPENAI_MODERATION_ENABLED: 'false',
          LANGFUSE_ENABLED: 'false'
        },
        encoding: 'utf8',
        timeout: 10_000
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('Completed safety eval case');
    expect(result.stdout).toContain(caseId);
    expect(result.stdout).toContain('passed: true');
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('offline-eval-network-blocked');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
