import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { installProcessErrorHandlers } from '../../runtime/process-errors';

function createLogger() {
  return {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {})
  };
}

describe('installProcessErrorHandlers', () => {
  let originalOn: typeof process.on;
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    originalOn = process.on;
    originalSetTimeout = globalThis.setTimeout;
  });

  afterEach(() => {
    process.on = originalOn;
    globalThis.setTimeout = originalSetTimeout;
  });

  test('awaits tracing shutdown before exiting on uncaught exception', async () => {
    const handlers = new Map<string, (error: unknown) => void>();
    process.on = ((event: string, handler: (error: unknown) => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on;

    const log = createLogger();
    let resolveShutdown: (() => void) | undefined;
    const shutdownTracing = mock(
      () =>
        new Promise<void>(resolve => {
          resolveShutdown = resolve;
        })
    );
    let exitCode: number | undefined;
    let exitCalls = 0;

    installProcessErrorHandlers({
      log: log as any,
      shutdownTracing,
      exit: ((code?: number) => {
        exitCalls += 1;
        exitCode = code;
        return undefined as never;
      }) as (code?: number) => never
    });

    handlers.get('uncaughtException')?.(new Error('boom'));

    await Promise.resolve();
    expect(exitCalls).toBe(0);

    resolveShutdown?.();
    await new Promise(resolve => originalSetTimeout(resolve, 0));

    expect(shutdownTracing).toHaveBeenCalledTimes(1);
    expect(exitCalls).toBe(1);
    expect(exitCode).toBe(1);
  });

  test('uses the configured tracing shutdown timeout budget', async () => {
    const handlers = new Map<string, (error: unknown) => void>();
    process.on = ((event: string, handler: (error: unknown) => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on;

    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const log = createLogger();
    let exitCode: number | undefined;

    installProcessErrorHandlers({
      log: log as any,
      shutdownTracing: mock(() => new Promise<void>(() => {})),
      tracingShutdownTimeoutMs: 5,
      exit: ((code?: number) => {
        exitCode = code;
        return undefined as never;
      }) as (code?: number) => never
    });

    handlers.get('uncaughtException')?.(new Error('boom'));
    await new Promise(resolve => originalSetTimeout(resolve, 0));

    expect(exitCode).toBe(1);
    expect(log.warn).toHaveBeenCalledWith('Tracing shutdown timed out after fatal runtime error', {
      tracingShutdownTimeoutMs: 5
    });
  });

  test('awaits tracing shutdown before exiting on unhandled rejection', async () => {
    const handlers = new Map<string, (error: unknown) => void>();
    process.on = ((event: string, handler: (error: unknown) => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.on;

    const log = createLogger();
    let resolveShutdown: (() => void) | undefined;
    const shutdownTracing = mock(
      () =>
        new Promise<void>(resolve => {
          resolveShutdown = resolve;
        })
    );
    let exitCode: number | undefined;

    installProcessErrorHandlers({
      log: log as any,
      shutdownTracing,
      exit: ((code?: number) => {
        exitCode = code;
        return undefined as never;
      }) as (code?: number) => never
    });

    handlers.get('unhandledRejection')?.(new Error('boom'));

    await Promise.resolve();
    expect(exitCode).toBeUndefined();

    resolveShutdown?.();
    await new Promise(resolve => originalSetTimeout(resolve, 0));

    expect(shutdownTracing).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
  });
});
