import { describe, expect, test } from 'bun:test';
import { combineAbortSignals } from '../../runtime/abort-signals';

describe('combineAbortSignals', () => {
  test('uses the required signal when no optional signal is provided', () => {
    const required = new AbortController();
    const combined = combineAbortSignals(undefined, required.signal);

    expect(combined.aborted).toBe(false);
    required.abort();
    expect(combined.aborted).toBe(true);
  });

  test('observes both supplied signals', () => {
    const optional = new AbortController();
    const required = new AbortController();
    const combined = combineAbortSignals(optional.signal, required.signal);

    optional.abort();
    expect(combined.aborted).toBe(true);
  });
});
