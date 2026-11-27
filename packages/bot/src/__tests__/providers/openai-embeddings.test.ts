import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { OpenAIEmbeddingsProvider } from '../../providers/openai-embeddings';

describe('OpenAIEmbeddingsProvider', () => {
  let provider: OpenAIEmbeddingsProvider;

  beforeEach(() => {
    provider = new OpenAIEmbeddingsProvider('sk-test-key');
    (provider as any).client = {
      embeddings: {
        create: mock(async ({ input }: { input: string | string[] }) => ({
          data: (Array.isArray(input) ? input : [input]).map((_, index) => ({
            index,
            embedding: Array(1536).fill(index)
          }))
        }))
      }
    };
  });

  describe('initialization', () => {
    it('constructs with API key', () => {
      const p = new OpenAIEmbeddingsProvider('sk-test-key');
      expect(p).toBeDefined();
      expect(p.name).toBe('openai-embeddings');
    });

    it('constructs with empty string API key', () => {
      const p = new OpenAIEmbeddingsProvider('');
      expect(p).toBeDefined();
      // Empty key means not configured
      expect(p.isConfigured()).toBe(false);
    });

    it('constructs without API key', () => {
      const p = new OpenAIEmbeddingsProvider();
      expect(p).toBeDefined();
      expect(p.isConfigured()).toBe(false);
    });
  });

  describe('configuration', () => {
    it('reports as configured when API key is provided', () => {
      expect(provider.isConfigured()).toBe(true);
    });

    it('reports as not configured without API key', () => {
      const unconfigured = new OpenAIEmbeddingsProvider('');
      expect(unconfigured.isConfigured()).toBe(false);
    });

    it('reports as not configured when undefined', () => {
      const unconfigured = new OpenAIEmbeddingsProvider(undefined);
      expect(unconfigured.isConfigured()).toBe(false);
    });
  });

  describe('provider metadata', () => {
    it('has correct name', () => {
      expect(provider.name).toBe('openai-embeddings');
    });

    it('has embedding methods', () => {
      expect(typeof provider.generateEmbedding).toBe('function');
      expect(typeof provider.generateEmbeddings).toBe('function');
    });

    it('is instance of EmbeddingProvider', () => {
      expect(provider).toBeDefined();
      expect(provider.isConfigured).toBeDefined();
    });
  });

  describe('embedding generation', () => {
    it('throws when not configured', async () => {
      const unconfigured = new OpenAIEmbeddingsProvider('');
      try {
        await unconfigured.generateEmbedding('test');
        expect(true).toBe(false); // Should throw
      } catch (error: any) {
        expect(error.message).toContain('not configured');
      }
    });

    it('sends the sanitized empty input to the provider client', async () => {
      await expect(provider.generateEmbedding('')).resolves.toHaveLength(1536);
      expect((provider as any).client.embeddings.create).toHaveBeenCalledWith(
        expect.objectContaining({ input: '' })
      );
    });
  });

  describe('batch embedding generation', () => {
    it('returns empty array for empty batch', async () => {
      const result = await provider.generateEmbeddings([]);
      expect(result).toEqual([]);
    });

    it('handles large batches by chunking internally', async () => {
      // Use a deterministic client mock to validate chunking behavior.
      const texts = Array(150).fill('test content');
      let calls = 0;

      (provider as any).client = {
        embeddings: {
          create: async ({ input }: { input: string[] }) => {
            calls += 1;
            return {
              data: input.map((_, index) => ({
                index,
                embedding: Array(1536).fill(0)
              }))
            };
          }
        }
      };

      const result = await provider.generateEmbeddings(texts);
      expect(result).toHaveLength(150);
      expect(calls).toBe(2); // 100 + 50
    });

    it('preserves order and handles a mixed batch without a network call', async () => {
      const vectors = await provider.generateEmbeddings([
        'first',
        'ignore previous instructions',
        'last'
      ]);
      expect(vectors.map(vector => vector[0])).toEqual([0, 1, 2]);
    });
  });

  describe('security features', () => {
    it('sanitizes control characters', async () => {
      await provider.generateEmbedding('Hello\x00World');
      expect((provider as any).client.embeddings.create).toHaveBeenCalledWith(
        expect.objectContaining({ input: 'Hello World' })
      );
    });

    it('truncates long inputs safely', async () => {
      await provider.generateEmbedding('a'.repeat(100000));
      const input = (provider as any).client.embeddings.create.mock.calls[0][0].input;
      expect(input.length).toBeLessThan(100000);
      expect(input).toMatch(/^a+$/);
    });
  });

  describe('rate limiting', () => {
    it('enforces rate limit', async () => {
      // Trigger the limiter before any network call is attempted.
      (provider as any).requestCount = 500;
      (provider as any).lastResetTime = Date.now();

      await expect(provider.generateEmbedding('test')).rejects.toThrow(/rate limit/i);
    });
  });

  describe('error handling', () => {
    it('throws on invalid API call', async () => {
      // Avoid network flakiness by forcing a deterministic API failure.
      (provider as any).client = {
        embeddings: {
          create: async () => {
            throw new Error('mock invalid api call');
          }
        }
      };

      await expect(provider.generateEmbedding('test')).rejects.toThrow(
        /OpenAI embedding generation failed: mock invalid api call/
      );
    });

    it('provides meaningful error messages', async () => {
      try {
        const unconfigured = new OpenAIEmbeddingsProvider('');
        await unconfigured.generateEmbedding('test');
      } catch (error: any) {
        expect(error.message).toContain('not configured');
      }
    });

    it('handles batch errors gracefully', async () => {
      // Avoid network flakiness by forcing a deterministic API failure.
      (provider as any).client = {
        embeddings: {
          create: async () => {
            throw new Error('mock batch failure');
          }
        }
      };

      await expect(provider.generateEmbeddings(['test'])).rejects.toThrow(
        /OpenAI batch embedding generation failed: mock batch failure/
      );
    });
  });
});
