import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { resetShutdownStateForTests, shutdownApplication } from '../../runtime/shutdown';

function createLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  };
}

describe('shutdownApplication', () => {
  beforeEach(() => {
    resetShutdownStateForTests();
  });

  test('flushes tracing and closes runtime resources once', async () => {
    const shutdownTracing = mock(async () => {});
    const stop = mock(async () => {});
    const destroy = mock(() => {});
    const disconnect = mock(async () => {});
    const releaseProcessLock = mock(() => {});
    const stopRadio = mock(async () => {});
    const exit = mock((() => undefined) as (code?: number) => never);

    await shutdownApplication({
      signal: 'SIGTERM',
      client: { destroy } as never,
      db: { disconnect } as never,
      healthServer: { stop } as never,
      releaseProcessLock,
      shutdownTracing,
      stopRadio,
      log: createLogger(),
      exit
    });

    expect(shutdownTracing).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopRadio).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(releaseProcessLock).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
