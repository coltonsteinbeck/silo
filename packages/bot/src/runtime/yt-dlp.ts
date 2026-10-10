import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export class YtDlpExecutableResolutionError extends Error {
  readonly code = 'ytdlp_packaged_binary_unavailable';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'YtDlpExecutableResolutionError';
  }
}

export function resolveYtDlpExecutable({
  env = process.env,
  platform = process.platform,
  resolvePackageJson = () => require.resolve('youtube-dl-exec/package.json'),
  pathExists = existsSync
}: {
  env?: typeof process.env;
  platform?: typeof process.platform;
  resolvePackageJson?: () => string;
  pathExists?: (candidate: string) => boolean;
} = {}): string {
  const explicitPath = String(env.YTDLP_PATH || '').trim();
  if (explicitPath) {
    return explicitPath;
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = resolvePackageJson();
  } catch (error) {
    throw new YtDlpExecutableResolutionError(
      'The packaged yt-dlp executable is unavailable. Run `bun run runtime:prepare`.',
      { cause: error }
    );
  }

  const filename = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const executablePath = path.join(path.dirname(packageJsonPath), 'bin', filename);
  if (!pathExists(executablePath)) {
    throw new YtDlpExecutableResolutionError(
      'The packaged yt-dlp executable is unavailable. Run `bun run runtime:prepare`.'
    );
  }

  return executablePath;
}
