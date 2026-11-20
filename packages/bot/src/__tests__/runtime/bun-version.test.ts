import { describe, expect, test } from 'bun:test';
import { assertReleaseBunRuntime } from '../../runtime/bun-version';

describe('release runtime guard', () => {
  test('accepts only the certified Bun patch release', () => {
    expect(assertReleaseBunRuntime('1.4.4')).toBe('1.4.4');
    expect(assertReleaseBunRuntime()).toBe('1.4.4');
    for (const version of ['', '1.3.5', '1.4.3', '1.4.5', '1.5.0']) {
      expect(() => assertReleaseBunRuntime(version)).toThrow('Silo requires Bun 1.4.4');
    }
  });
});
