import { describe, expect, mock, test } from 'bun:test';
import {
  buildMediaReplyPayload,
  resolveDeliverableMediaResult
} from '../../services/media-delivery';

describe('media delivery', () => {
  test('fetches remote image URL server-side and returns an attachment without URL content', async () => {
    const fetchImpl = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'content-type': 'image/png',
          'content-length': '3'
        }
      });
    }) as unknown as typeof fetch;

    const payload = await buildMediaReplyPayload(
      {
        kind: 'image',
        url: 'https://cdn.example.com/generated.png',
        prompt: 'draw a thing'
      },
      { fetchImpl, now: () => 123 }
    );

    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.com/generated.png');
    expect(payload.uploaded).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(payload.content).toBeUndefined();
  });

  test('decodes data image URLs into an attachment without fetch', async () => {
    const fetchImpl = mock(async () => {
      throw new Error('fetch should not run for data images');
    }) as unknown as typeof fetch;

    const payload = await buildMediaReplyPayload(
      {
        kind: 'image',
        url: `data:image/png;base64,${Buffer.from('png-data').toString('base64')}`,
        prompt: 'draw a thing'
      },
      { fetchImpl, now: () => 123 }
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(payload.uploaded).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(payload.content).toBeUndefined();
  });

  test('fetches remote video URL server-side and returns an attachment without URL content', async () => {
    const fetchImpl = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: {
          'content-type': 'video/mp4',
          'content-length': '4'
        }
      });
    }) as unknown as typeof fetch;

    const payload = await buildMediaReplyPayload(
      {
        kind: 'video',
        url: 'https://cdn.example.com/generated.mp4',
        prompt: 'animate a thing'
      },
      { fetchImpl, now: () => 123 }
    );

    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.com/generated.mp4');
    expect(payload.uploaded).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(payload.content).toBeUndefined();
  });

  test('returns no-link failure when remote media is too large', async () => {
    const fetchImpl = mock(async () => {
      return new Response(new Uint8Array([1]), {
        headers: {
          'content-type': 'video/mp4',
          'content-length': '10'
        }
      });
    }) as unknown as typeof fetch;

    const payload = await buildMediaReplyPayload(
      {
        kind: 'video',
        url: 'https://cdn.example.com/generated.mp4',
        prompt: 'animate a thing'
      },
      { fetchImpl, maxBytes: 4 }
    );

    expect(payload.uploaded).toBe(false);
    expect(payload.files).toHaveLength(0);
    expect(payload.content).toContain('Could not upload video inline');
    expect(payload.content).not.toContain('https://cdn.example.com/generated.mp4');
  });

  test('returns no-link failure when remote fetch fails', async () => {
    const fetchImpl = mock(async () => {
      return new Response('not found', {
        status: 404
      });
    }) as unknown as typeof fetch;

    const payload = await buildMediaReplyPayload(
      {
        kind: 'image',
        url: 'https://cdn.example.com/generated.png',
        prompt: 'draw a thing'
      },
      { fetchImpl }
    );

    expect(payload.uploaded).toBe(false);
    expect(payload.files).toHaveLength(0);
    expect(payload.content).toContain('Could not upload image inline');
    expect(payload.content).not.toContain('https://cdn.example.com/generated.png');
  });

  test('suppresses media delivery when assistant output was blocked', () => {
    const media = {
      kind: 'image' as const,
      url: 'https://cdn.example.com/generated.png',
      prompt: 'draw a thing'
    };

    expect(resolveDeliverableMediaResult(media, true)).toBeNull();
    expect(resolveDeliverableMediaResult(media, false)).toBe(media);
  });
});
