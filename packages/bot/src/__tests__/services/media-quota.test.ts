import { describe, expect, test } from 'bun:test';
import { calculateVideoQuotaCost } from '../../services/media-quota';

describe('video quota estimate', () => {
  test('charges every second and charges references once', () => {
    expect(calculateVideoQuotaCost(5, '480p', 0)).toBe(200);
    expect(calculateVideoQuotaCost(10, '480p', 2)).toBe(410);
    expect(calculateVideoQuotaCost(8, '720p', 1)).toBe(565);
  });
  test('rejects values outside the supported request bounds', () => {
    for (const duration of [NaN, Infinity, -1, 0, 1.5, 11]) {
      expect(() => calculateVideoQuotaCost(duration, '480p', 0)).toThrow();
    }
    expect(() => calculateVideoQuotaCost(5, '1080p', 0)).toThrow();
    expect(() => calculateVideoQuotaCost(5, '480p', 3)).toThrow();
  });
});
