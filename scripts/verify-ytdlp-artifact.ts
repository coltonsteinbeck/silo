import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolveYtDlpExecutable } from '../packages/bot/src/runtime/yt-dlp';
import { PINNED_YTDLP_SHA256, PINNED_YTDLP_VERSION } from './radio-validation-policy';

try {
  const executable = resolveYtDlpExecutable();
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  if (digest !== PINNED_YTDLP_SHA256) {
    throw new Error('checksum_mismatch');
  }

  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
  if (version !== PINNED_YTDLP_VERSION) {
    throw new Error('version_mismatch');
  }

  console.log(`Pinned yt-dlp artifact verified: version=${version} sha256=verified.`);
} catch {
  console.error(
    'Pinned yt-dlp artifact verification failed. Run `bun run runtime:prepare` and retry.'
  );
  process.exitCode = 1;
}
