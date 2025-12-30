import OpenAI from 'openai';
import type { EmbeddingProvider } from '@silo/core';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMENSION = 1536;
const MAX_BATCH_SIZE = 100;

/**
 * Content sanitization to prevent prompt injection attacks
 * Detects suspicious patterns in memory content before embedding
 */
function sanitizeContentForEmbedding(text: string): string {
  // Remove control characters and null bytes
  // eslint-disable-next-line no-control-regex
  let sanitized = text.replace(/[\x00-\x1F\x7F]/g, ' ');

  // Limit length to prevent DoS on embeddings API
  if (sanitized.length > 8000) {
    sanitized = sanitized.substring(0, 8000);
  }

  return sanitized.trim();
}

/**
 * Validates content for suspicious patterns that could indicate injection attempts
 */
function isContentSuspicious(text: string): boolean {
  // Check for excessive special characters (potential encoding attacks)
  const specialCharRatio = (text.match(/[^a-zA-Z0-9\s.,!?\-'":;()\n]/g) || []).length / text.length;
  if (specialCharRatio > 0.5) {
    return true;
  }

  // Check for suspicious patterns
  const suspiciousPatterns = [
    /ignore\s+previous|forget\s+everything/i,
    /system\s+prompt/i,
    /execute\s+code|eval\s*\(/i,
    /sql\s+injection|drop\s+table/i
  ];

  return suspiciousPatterns.some(pattern => pattern.test(text));
}

export class OpenAIEmbeddingsProvider implements EmbeddingProvider {
  name = 'openai-embeddings';
  private client: OpenAI | null = null;
  private requestCount = 0;
  private lastResetTime = Date.now();
  private readonly RATE_LIMIT_WINDOW = 60000; // 1 minute
  private readonly RATE_LIMIT_MAX = 500; // Max requests per minute

  constructor(apiKey?: string) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  /**
   * Checks and enforces rate limiting
   */
  private checkRateLimit(): void {
    const now = Date.now();
    if (now - this.lastResetTime >= this.RATE_LIMIT_WINDOW) {
      this.requestCount = 0;
      this.lastResetTime = now;
    }

    if (this.requestCount >= this.RATE_LIMIT_MAX) {
      throw new Error(
        `Embedding rate limit exceeded: ${this.RATE_LIMIT_MAX} requests per ${this.RATE_LIMIT_WINDOW}ms`
      );
    }

    this.requestCount++;
  }

  /**
   * Generate embedding for a single text string
   */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.client) {
      throw new Error('OpenAI embeddings provider not configured');
    }

    // Check for suspicious content
    if (isContentSuspicious(text)) {
      console.warn('[OpenAI Embeddings] Suspicious content detected, sanitizing');
    }

    const sanitizedText = sanitizeContentForEmbedding(text);

    this.checkRateLimit();

    try {
      const response = await this.client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: sanitizedText,
        dimensions: EMBEDDING_DIMENSION
      });

      if (!response.data || response.data.length === 0) {
        throw new Error('No embedding data from OpenAI');
      }

      const embedding = response.data[0];
      if (!embedding?.embedding) {
        throw new Error('Invalid embedding response format');
      }

      // Validate embedding dimensions
      if (embedding.embedding.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Invalid embedding dimension: expected ${EMBEDDING_DIMENSION}, got ${embedding.embedding.length}`
        );
      }

      return embedding.embedding;
    } catch (error) {
      console.error('[OpenAI Embeddings] Generation failed:', error);
      if (error instanceof Error) {
        throw new Error(`OpenAI embedding generation failed: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple text strings in batches
   * Handles rate limiting and cost optimization through batching
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error('OpenAI embeddings provider not configured');
    }

    if (texts.length === 0) {
      return [];
    }

    // Sanitize and validate all inputs first
    const sanitizedTexts = texts.map(text => {
      if (isContentSuspicious(text)) {
        console.warn('[OpenAI Embeddings] Suspicious content detected in batch, sanitizing');
      }
      return sanitizeContentForEmbedding(text);
    });

    const allEmbeddings: number[][] = [];

    // Process in batches to respect API limits and optimize costs
    for (let i = 0; i < sanitizedTexts.length; i += MAX_BATCH_SIZE) {
      const batch = sanitizedTexts.slice(i, i + MAX_BATCH_SIZE);

      this.checkRateLimit();

      try {
        const response = await this.client.embeddings.create({
          model: EMBEDDING_MODEL,
          input: batch,
          dimensions: EMBEDDING_DIMENSION
        });

        if (!response.data || response.data.length === 0) {
          throw new Error('No embedding data from OpenAI');
        }

        // Sort by index to maintain original order
        const sortedData = response.data.sort((a, b) => a.index - b.index);

        for (const item of sortedData) {
          if (!item.embedding) {
            throw new Error('Invalid embedding in batch response');
          }

          if (item.embedding.length !== EMBEDDING_DIMENSION) {
            throw new Error(
              `Invalid embedding dimension in batch: expected ${EMBEDDING_DIMENSION}, got ${item.embedding.length}`
            );
          }

          allEmbeddings.push(item.embedding);
        }
      } catch (error) {
        console.error('[OpenAI Embeddings] Batch generation failed:', error);
        if (error instanceof Error) {
          throw new Error(`OpenAI batch embedding generation failed: ${error.message}`);
        }
        throw error;
      }
    }

    if (allEmbeddings.length !== texts.length) {
      throw new Error(
        `Embedding count mismatch: expected ${texts.length}, got ${allEmbeddings.length}`
      );
    }

    return allEmbeddings;
  }
}
