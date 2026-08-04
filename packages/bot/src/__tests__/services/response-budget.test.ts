import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_TEXT_RESPONSE_TOKENS,
  resolveTextResponseTokenLimit
} from '../../services/response-budget';

describe('text response budget', () => {
  test('uses the configured 400-token ceiling when quota has enough room', () => {
    expect(DEFAULT_MAX_TEXT_RESPONSE_TOKENS).toBe(400);
    expect(resolveTextResponseTokenLimit(20_000)).toBe(400);
  });

  test('clamps generation to the remaining user quota', () => {
    expect(resolveTextResponseTokenLimit(17)).toBe(17);
  });
});
