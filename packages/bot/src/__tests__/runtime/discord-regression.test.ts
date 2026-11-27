import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test.each(['regression', 'regression-search'])(
  'dispatches simulated Discord events with the real app handlers (%s)',
  mode => {
    const fixture = fileURLToPath(new URL('./offline-startup-smoke.fixture.ts', import.meta.url));
    const result = Bun.spawnSync([process.execPath, '--no-env-file', fixture, mode], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain('offline-discord-regression-passed');
  },
  20_000
);
