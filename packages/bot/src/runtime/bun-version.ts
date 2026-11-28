export const RELEASE_BUN_VERSION = '1.4.5';

export function assertReleaseBunRuntime(
  version: string | undefined = typeof Bun === 'undefined' ? undefined : Bun.version
): string {
  if (version !== RELEASE_BUN_VERSION) {
    throw new Error(`Silo requires Bun ${RELEASE_BUN_VERSION} for this release`);
  }
  return version;
}
