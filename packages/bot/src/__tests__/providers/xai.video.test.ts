import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { XAIProvider } from '../../providers/xai';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('XAIProvider.generateVideo', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSetTimeout = globalThis.setTimeout;
    originalDateNow = Date.now;

    globalThis.setTimeout = ((callback: Parameters<typeof setTimeout>[0]) => {
      if (typeof callback === 'function') {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
  });

  test('returns completed video URL after polling', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/videos/generations')) {
        return jsonResponse({ request_id: 'req-1' });
      }
      if (url.endsWith('/videos/req-1')) {
        return jsonResponse({
          status: 'done',
          model: 'grok-imagine-video',
          video: {
            url: 'https://cdn.example.com/video.mp4',
            duration: 8,
            respect_moderation: true
          }
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    const result = await provider.generateVideo('make a sunrise timelapse');

    expect(result.url).toBe('https://cdn.example.com/video.mp4');
    expect(result.model).toBe('grok-imagine-video');
    expect(result.duration).toBe(8);
  });

  test('throws when request_id is missing from initial response', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/videos/generations')) {
        return jsonResponse({});
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    await expect(provider.generateVideo('make a sunrise timelapse')).rejects.toThrow(
      'xAI video generation did not return request_id'
    );
  });

  test('throws when generation status is failed', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/videos/generations')) {
        return jsonResponse({ request_id: 'req-2' });
      }
      if (url.endsWith('/videos/req-2')) {
        return jsonResponse({ status: 'failed', error: 'generation failed upstream' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    await expect(provider.generateVideo('make a sunrise timelapse')).rejects.toThrow(
      'generation failed upstream'
    );
  });

  test('throws when generation status is expired', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/videos/generations')) {
        return jsonResponse({ request_id: 'req-3' });
      }
      if (url.endsWith('/videos/req-3')) {
        return jsonResponse({ status: 'expired' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    await expect(provider.generateVideo('make a sunrise timelapse')).rejects.toThrow(
      'xAI video generation request expired'
    );
  });

  test('throws when completed status has no video URL', async () => {
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/videos/generations')) {
        return jsonResponse({ request_id: 'req-4' });
      }
      if (url.endsWith('/videos/req-4')) {
        return jsonResponse({ status: 'done', video: {} });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    await expect(provider.generateVideo('make a sunrise timelapse')).rejects.toThrow(
      'xAI video generation completed without a URL'
    );
  });

  test('throws after timeout window elapses', async () => {
    const start = 1_000_000;
    let timeCall = 0;
    const timeline = [start, start, start + 12 * 60 * 1000 + 1];
    Date.now = () => {
      const value = timeline[Math.min(timeCall, timeline.length - 1)] ?? start;
      timeCall += 1;
      return value;
    };

    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/videos/generations')) {
        return jsonResponse({ request_id: 'req-5' });
      }
      if (url.endsWith('/videos/req-5')) {
        return jsonResponse({ status: 'processing' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const provider = new XAIProvider('xai-key');
    await expect(provider.generateVideo('make a sunrise timelapse')).rejects.toThrow(
      'xAI video generation timed out'
    );
  });
});
