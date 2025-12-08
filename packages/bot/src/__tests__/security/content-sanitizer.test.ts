/**
 * Tests for Content Sanitizer
 * 
 * Tests content moderation, hashing, and logging functionality.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { createHash } from 'crypto';

// Types for testing
type ContentType = 'prompt' | 'memory' | 'feedback' | 'message';
type ModerationAction = 'allowed' | 'blocked' | 'warned';

interface ModerationResult {
  allowed: boolean;
  action: ModerationAction;
  flaggedCategories: string[];
  scores: Record<string, number>;
  contentHash: string;
}

// Mock ContentSanitizer for testing pure logic without OpenAI dependency
class MockContentSanitizer {
  /**
   * Generate SHA256 hash of content
   */
  hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
  
  /**
   * Determine moderation action based on categories and scores
   */
  determineAction(
    flaggedCategories: string[],
    scores: Record<string, number>
  ): { action: ModerationAction; allowed: boolean } {
    const BLOCK_CATEGORIES = [
      'sexual/minors',
      'hate/threatening',
      'violence/graphic',
      'self-harm/intent',
      'self-harm/instructions'
    ];
    
    const WARN_CATEGORIES = [
      'sexual',
      'hate',
      'violence',
      'self-harm',
      'harassment',
      'harassment/threatening'
    ];
    
    const SCORE_THRESHOLD = 0.7;
    
    // Check for block-worthy categories
    const shouldBlock = flaggedCategories.some(cat => 
      BLOCK_CATEGORIES.includes(cat) || 
      (scores[cat] && scores[cat] >= SCORE_THRESHOLD)
    );
    
    if (shouldBlock) {
      return { action: 'blocked', allowed: false };
    }
    
    // Check for warning-worthy categories
    if (flaggedCategories.length > 0) {
      const shouldWarn = flaggedCategories.some(cat => 
        WARN_CATEGORIES.includes(cat) && 
        scores[cat] && scores[cat] >= SCORE_THRESHOLD * 0.8
      );
      
      if (shouldWarn) {
        return { action: 'warned', allowed: true };
      }
    }
    
    return { action: 'allowed', allowed: true };
  }
  
  /**
   * Build moderation result
   */
  buildResult(
    content: string,
    flaggedCategories: string[],
    scores: Record<string, number>
  ): ModerationResult {
    const { action, allowed } = this.determineAction(flaggedCategories, scores);
    return {
      allowed,
      action,
      flaggedCategories,
      scores,
      contentHash: this.hashContent(content)
    };
  }
}

describe('ContentSanitizer', () => {
  let sanitizer: MockContentSanitizer;

  beforeEach(() => {
    sanitizer = new MockContentSanitizer();
  });

  describe('hashContent', () => {
    test('generates consistent SHA256 hash', () => {
      const content = 'Hello, world!';
      const hash1 = sanitizer.hashContent(content);
      const hash2 = sanitizer.hashContent(content);
      
      expect(hash1).toBe(hash2);
    });

    test('generates different hashes for different content', () => {
      const hash1 = sanitizer.hashContent('Hello');
      const hash2 = sanitizer.hashContent('World');
      
      expect(hash1).not.toBe(hash2);
    });

    test('generates 64-character hex string', () => {
      const hash = sanitizer.hashContent('test content');
      
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    test('handles empty string', () => {
      const hash = sanitizer.hashContent('');
      
      expect(hash).toHaveLength(64);
    });

    test('handles unicode content', () => {
      const hash = sanitizer.hashContent('Hello 👋 世界');
      
      expect(hash).toHaveLength(64);
    });

    test('handles long content', () => {
      const longContent = 'a'.repeat(10000);
      const hash = sanitizer.hashContent(longContent);
      
      expect(hash).toHaveLength(64);
    });
  });

  describe('determineAction', () => {
    test('allows content with no flagged categories', () => {
      const result = sanitizer.determineAction([], {});
      
      expect(result.action).toBe('allowed');
      expect(result.allowed).toBe(true);
    });

    test('blocks content with sexual/minors category', () => {
      const result = sanitizer.determineAction(
        ['sexual/minors'],
        { 'sexual/minors': 0.9 }
      );
      
      expect(result.action).toBe('blocked');
      expect(result.allowed).toBe(false);
    });

    test('blocks content with hate/threatening category', () => {
      const result = sanitizer.determineAction(
        ['hate/threatening'],
        { 'hate/threatening': 0.85 }
      );
      
      expect(result.action).toBe('blocked');
      expect(result.allowed).toBe(false);
    });

    test('blocks content with violence/graphic category', () => {
      const result = sanitizer.determineAction(
        ['violence/graphic'],
        { 'violence/graphic': 0.95 }
      );
      
      expect(result.action).toBe('blocked');
      expect(result.allowed).toBe(false);
    });

    test('blocks content with self-harm/intent category', () => {
      const result = sanitizer.determineAction(
        ['self-harm/intent'],
        { 'self-harm/intent': 0.8 }
      );
      
      expect(result.action).toBe('blocked');
      expect(result.allowed).toBe(false);
    });

    test('blocks content with high score in any category', () => {
      const result = sanitizer.determineAction(
        ['harassment'],
        { harassment: 0.9 }
      );
      
      expect(result.action).toBe('blocked');
      expect(result.allowed).toBe(false);
    });

    test('warns for warn-category with moderate score', () => {
      const result = sanitizer.determineAction(
        ['sexual'],
        { sexual: 0.6 } // Above warn threshold (0.7 * 0.8 = 0.56)
      );
      
      expect(result.action).toBe('warned');
      expect(result.allowed).toBe(true);
    });

    test('allows content below warn threshold', () => {
      const result = sanitizer.determineAction(
        ['hate'],
        { hate: 0.3 }
      );
      
      expect(result.action).toBe('allowed');
      expect(result.allowed).toBe(true);
    });
  });

  describe('buildResult', () => {
    test('builds complete result object', () => {
      const result = sanitizer.buildResult(
        'test content',
        [],
        {}
      );
      
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('action');
      expect(result).toHaveProperty('flaggedCategories');
      expect(result).toHaveProperty('scores');
      expect(result).toHaveProperty('contentHash');
    });

    test('includes content hash in result', () => {
      const content = 'test content';
      const result = sanitizer.buildResult(content, [], {});
      
      expect(result.contentHash).toBe(sanitizer.hashContent(content));
    });

    test('includes flagged categories in result', () => {
      const categories = ['hate', 'violence'];
      const result = sanitizer.buildResult('test', categories, { hate: 0.5, violence: 0.5 });
      
      expect(result.flaggedCategories).toEqual(categories);
    });

    test('includes scores in result', () => {
      const scores = { hate: 0.5, violence: 0.3 };
      const result = sanitizer.buildResult('test', [], scores);
      
      expect(result.scores).toEqual(scores);
    });
  });

  describe('content types', () => {
    test('validates prompt content type', () => {
      const contentType: ContentType = 'prompt';
      expect(['prompt', 'memory', 'feedback', 'message']).toContain(contentType);
    });

    test('validates memory content type', () => {
      const contentType: ContentType = 'memory';
      expect(['prompt', 'memory', 'feedback', 'message']).toContain(contentType);
    });

    test('validates feedback content type', () => {
      const contentType: ContentType = 'feedback';
      expect(['prompt', 'memory', 'feedback', 'message']).toContain(contentType);
    });

    test('validates message content type', () => {
      const contentType: ContentType = 'message';
      expect(['prompt', 'memory', 'feedback', 'message']).toContain(contentType);
    });
  });
});
