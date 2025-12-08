/**
 * Tests for Rate Limiter
 * 
 * Tests rate limiting logic including window expiration,
 * max request enforcement, and key-based tracking.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { RateLimiter } from '../../utils/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  describe('basic functionality', () => {
    beforeEach(() => {
      limiter = new RateLimiter(5, 60000); // 5 requests per minute
    });

    test('allows first request', () => {
      const result = limiter.check('user1');
      
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    test('tracks requests per key', () => {
      limiter.check('user1');
      limiter.check('user1');
      const result = limiter.check('user1');
      
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });

    test('separate keys are tracked independently', () => {
      limiter.check('user1');
      limiter.check('user1');
      limiter.check('user1');
      
      const result = limiter.check('user2');
      
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // user2 starts fresh
    });

    test('blocks after max requests reached', () => {
      // Use all 5 requests
      for (let i = 0; i < 5; i++) {
        limiter.check('user1');
      }
      
      const result = limiter.check('user1');
      
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    test('returns resetAt timestamp', () => {
      const before = Date.now();
      const result = limiter.check('user1');
      const after = Date.now();
      
      expect(result.resetAt).toBeGreaterThanOrEqual(before + 60000);
      expect(result.resetAt).toBeLessThanOrEqual(after + 60000);
    });
  });

  describe('window expiration', () => {
    test('resets count after window expires', async () => {
      // Use a short window for testing
      limiter = new RateLimiter(2, 50); // 2 requests per 50ms
      
      limiter.check('user1');
      limiter.check('user1');
      
      // Should be at limit
      let result = limiter.check('user1');
      expect(result.allowed).toBe(false);
      
      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 60));
      
      // Should be allowed again
      result = limiter.check('user1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });
  });

  describe('reset method', () => {
    beforeEach(() => {
      limiter = new RateLimiter(3, 60000);
    });

    test('resets a specific key', () => {
      limiter.check('user1');
      limiter.check('user1');
      
      limiter.reset('user1');
      
      const result = limiter.check('user1');
      expect(result.remaining).toBe(2); // Fresh start
    });

    test('reset does not affect other keys', () => {
      limiter.check('user1');
      limiter.check('user2');
      limiter.check('user2');
      
      limiter.reset('user1');
      
      const result = limiter.check('user2');
      expect(result.remaining).toBe(0); // user2 unchanged
    });

    test('reset is safe for non-existent keys', () => {
      expect(() => limiter.reset('nonexistent')).not.toThrow();
    });
  });

  describe('edge cases', () => {
    test('handles single request limit', () => {
      limiter = new RateLimiter(1, 60000);
      
      let result = limiter.check('user1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
      
      result = limiter.check('user1');
      expect(result.allowed).toBe(false);
    });

    test('handles high request limit', () => {
      limiter = new RateLimiter(1000, 60000);
      
      for (let i = 0; i < 999; i++) {
        limiter.check('user1');
      }
      
      const result = limiter.check('user1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    test('handles empty key', () => {
      limiter = new RateLimiter(5, 60000);
      
      const result = limiter.check('');
      expect(result.allowed).toBe(true);
    });

    test('handles special characters in key', () => {
      limiter = new RateLimiter(5, 60000);
      
      const result = limiter.check('user:123:guild:456');
      expect(result.allowed).toBe(true);
    });
  });

  describe('concurrent usage patterns', () => {
    beforeEach(() => {
      limiter = new RateLimiter(10, 60000);
    });

    test('tracks multiple users simultaneously', () => {
      const users = ['user1', 'user2', 'user3', 'user4', 'user5'];
      
      // Each user makes 3 requests
      for (const user of users) {
        limiter.check(user);
        limiter.check(user);
        limiter.check(user);
      }
      
      // Each user should have 7 remaining
      for (const user of users) {
        const result = limiter.check(user);
        expect(result.remaining).toBe(6);
      }
    });

    test('handles rapid sequential requests', () => {
      limiter = new RateLimiter(100, 60000);
      
      for (let i = 0; i < 50; i++) {
        const result = limiter.check('rapiduser');
        expect(result.allowed).toBe(true);
      }
      
      const final = limiter.check('rapiduser');
      expect(final.remaining).toBe(49);
    });
  });
});
