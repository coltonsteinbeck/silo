import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('release image build sends committed source and excludes ignored files', () => {
  const root = mkdtempSync(join(tmpdir(), 'silo-image-context-'));
  const gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) {
    if (key.startsWith('GIT_')) delete gitEnv[key];
  }
  const run = (command: string, args: string[], env = gitEnv) =>
    spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });

  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'supabase/migrations'), { recursive: true });
    writeFileSync(join(root, 'supabase/migrations/001_fixture.sql'), 'SELECT 1;');
    copyFileSync(
      join(sourceRoot, 'scripts/build-release-image.sh'),
      join(root, 'scripts/build-release-image.sh')
    );
    copyFileSync(join(sourceRoot, '.dockerignore'), join(root, '.dockerignore'));
    writeFileSync(join(root, '.gitignore'), '.env\n*.dump\n');
    writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(root, 'app.txt'), 'committed');
    const fakeDocker = join(root, 'bin/docker');
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == build ]]; then
  [[ "$2" == --build-arg && "$3" == RELEASE_COMMIT=* && "\${@: -1}" == - ]]
  printf '%s' "\${3#RELEASE_COMMIT=}" > "$CAPTURE_SHA"
  tar -tf - > "$CAPTURE_MANIFEST"
elif [[ "$1" == image && "$2" == inspect ]]; then
  cat "$CAPTURE_SHA"
elif [[ "$1" == run ]]; then
  [[ "$2" == --rm && "$3" == -i && "$4" == --network && "$5" == none && "$6" == --read-only ]]
  grep -Fx 'supabase/migrations/001_fixture.sql' > /dev/null
  [[ "\${REJECT_IMAGE_PROBE:-0}" != 1 ]]
else
  exit 2
fi
`
    );
    chmodSync(fakeDocker, 0o755);
    expect(run('git', ['init', '-q']).status).toBe(0);
    expect(run('git', ['add', '-A']).status).toBe(0);
    expect(
      run('git', [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'fixture'
      ]).status
    ).toBe(0);

    writeFileSync(join(root, '.env'), 'ignored');
    writeFileSync(join(root, 'data.dump'), 'ignored');
    const captureManifest = join(root, 'manifest.txt');
    const captureSha = join(root, 'sha.txt');
    const env = {
      ...gitEnv,
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      CAPTURE_MANIFEST: captureManifest,
      CAPTURE_SHA: captureSha
    };
    const built = run('bash', ['scripts/build-release-image.sh', 'silo-bot:fixture'], env);
    expect(built.status).toBe(0);
    const manifest = readFileSync(captureManifest, 'utf8').split('\n');
    expect(manifest).toContain('app.txt');
    expect(manifest).toContain('.dockerignore');
    expect(manifest).not.toContain('.env');
    expect(manifest).not.toContain('data.dump');
    expect(readFileSync(captureSha, 'utf8')).toBe(run('git', ['rev-parse', 'HEAD']).stdout.trim());

    rmSync(captureManifest);
    rmSync(captureSha);
    expect(
      run('bash', ['scripts/build-release-image.sh', 'silo-bot:fixture'], {
        ...env,
        REJECT_IMAGE_PROBE: '1'
      }).status
    ).not.toBe(0);

    writeFileSync(join(root, 'untracked.txt'), 'not committed');
    expect(
      run('bash', ['scripts/build-release-image.sh', 'silo-bot:fixture'], env).status
    ).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
