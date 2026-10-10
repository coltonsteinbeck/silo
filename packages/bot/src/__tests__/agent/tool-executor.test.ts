import { describe, expect, mock, test } from 'bun:test';
import { QuotaMiddleware } from '../../middleware/quota';
import { createProviderToolExecutor } from '../../agent/tool-executor';

describe('createProviderToolExecutor', () => {
  test.each([
    { query: 'latest news' },
    { query: '', searchAuthorized: true },
    { query: 'search now', origin: 'slash-command', command: 'search', authorized: true }
  ])('rejects graph search before looking up or calling providers', async input => {
    const searchWeb = mock(async () => ({ content: 'unused', citations: [] }));
    const getWebSearchProvider = mock(() => ({ searchWeb }));
    const executor = createProviderToolExecutor({
      registry: { getWebSearchProvider } as any,
      preferredProviderName: 'openai'
    });
    expect(await executor({ name: 'web_search', input })).toEqual({
      name: 'web_search',
      status: 'unsupported',
      message: 'Web search requires an explicit search command.'
    });
    expect(getWebSearchProvider).not.toHaveBeenCalled();
    expect(searchWeb).not.toHaveBeenCalled();
  });

  test('falls back to the registry default video provider when the preferred provider has no video support', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://cdn.example.com/video.mp4',
      model: 'grok-imagine-video',
      moderationPassed: true
    }));
    const videoProvider = {
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    };
    const getVideoProvider = mock((name?: string) => {
      if (name === 'openai') {
        return null;
      }

      if (!name || name === 'xai') {
        return videoProvider as any;
      }

      return null;
    });
    const registry = {
      getVideoProvider,
      getConfiguredVideoModel: mock(() => 'grok-imagine-video')
    } as any;

    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'openai'
    });
    const result = await executor({
      name: 'video_generation',
      input: { prompt: 'make a sunset timelapse' }
    });

    expect(getVideoProvider).toHaveBeenCalledTimes(2);
    expect(getVideoProvider.mock.calls[0]?.[0]).toBe('openai');
    expect(getVideoProvider.mock.calls[1]?.[0]).toBeUndefined();
    expect(generateVideo).toHaveBeenCalledWith(
      'make a sunset timelapse',
      expect.objectContaining({ model: 'grok-imagine-video' })
    );
    expect(result.status).toBe('success');
  });

  test('honors an explicit video provider override before falling back', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://cdn.example.com/video.mp4',
      model: 'grok-imagine-video',
      moderationPassed: true
    }));
    const videoProvider = {
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    };
    const getVideoProvider = mock((name?: string) => {
      if (name === 'xai') {
        return videoProvider as any;
      }

      return null;
    });
    const registry = {
      getVideoProvider,
      getConfiguredVideoModel: mock(() => 'grok-imagine-video')
    } as any;

    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'openai'
    });
    const result = await executor({
      name: 'video_generation',
      input: { prompt: 'make a trailer', provider: 'xai' }
    });

    expect(getVideoProvider).toHaveBeenCalledTimes(1);
    expect(getVideoProvider).toHaveBeenCalledWith('xai');
    expect(generateVideo).toHaveBeenCalledWith(
      'make a trailer',
      expect.objectContaining({ model: 'grok-imagine-video' })
    );
    expect(result.status).toBe('success');
  });
});

for (const name of ['image_generation', 'video_generation'] as const) {
  test(`${name} propagates cancellation and discards a late media result`, async () => {
    const controller = new AbortController();
    const generate = mock(async (_prompt: string, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(new Error('cancelled media'));
      return { url: 'https://cdn.example.com/late', moderationPassed: true };
    });
    const provider = { name: 'xai', generateImage: generate, generateVideo: generate };
    const registry = {
      getImageProvider: () => provider,
      getVideoProvider: () => provider,
      getConfiguredImageModel: () => 'image-model',
      getConfiguredVideoModel: () => 'video-model'
    } as any;
    const executor = createProviderToolExecutor({
      registry,
      preferredProviderName: 'xai',
      signal: controller.signal
    });
    const result = await executor({ name, input: { prompt: 'a scene' } });
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('media');
    expect(result).not.toHaveProperty('raw');
    await expect(executor({ name, input: { prompt: 'another scene' } })).rejects.toThrow(
      'cancelled media'
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test(`${name} rechecks cancellation after quota admission before paid I/O`, async () => {
    const controller = new AbortController();
    const executeReserved = mock(async (params: any) => {
      controller.abort(new Error('cancelled during quota admission'));
      await params.beforeAttempt();
      return { allowed: true, value: await params.execute() };
    });
    const getImageProvider = mock(() => {
      throw new Error('must not reach provider');
    });
    const executor = createProviderToolExecutor({
      registry: { getImageProvider, getVideoProvider: getImageProvider } as any,
      preferredProviderName: 'xai',
      signal: controller.signal,
      quota: {
        middleware: { executeReserved } as any,
        operationKey: 'turn',
        guildId: 'guild',
        userId: 'user',
        member: {} as any,
        referenceImageCount: 0
      }
    });
    await expect(executor({ name, input: { prompt: 'a scene' } })).rejects.toThrow(
      'cancelled during quota admission'
    );
    expect(getImageProvider).not.toHaveBeenCalled();
  });

  test(`${name} rejects provider moderation failure without retaining an asset`, async () => {
    const generate = mock(async () => ({
      url: 'https://cdn.example.com/rejected',
      moderationPassed: false
    }));
    const provider = { name: 'xai', generateImage: generate, generateVideo: generate };
    const executor = createProviderToolExecutor({
      preferredProviderName: 'xai',
      registry: {
        getImageProvider: () => provider,
        getVideoProvider: () => provider,
        getConfiguredImageModel: () => 'image-model',
        getConfiguredVideoModel: () => 'video-model'
      } as any
    });
    const result = await executor({ name, input: { prompt: 'a scene' } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('media');
    expect(result).not.toHaveProperty('raw');
    expect(JSON.stringify(result)).not.toContain('cdn.example.com');
  });

  test(`${name} reserves before I/O and denies concurrent and duplicate requests`, async () => {
    const cost = name === 'image_generation' ? 3 : 330;
    const reservations = new Map<string, any>();
    let used = 0;
    const admin = {
      reserveQuotaUsage: mock(async (request: any) => {
        const previous = reservations.get(request.idempotencyKey);
        if (previous) return { ...previous, idempotent: true };
        const allowed = used + request.requestedAmount <= cost;
        const row = {
          idempotencyKey: request.idempotencyKey,
          allowed,
          status: allowed ? 'reserved' : 'denied',
          reason: allowed ? null : 'user_quota_exceeded',
          reservedAmount: request.requestedAmount,
          remaining: allowed ? 0 : cost - used,
          userLimit: cost,
          guildLimit: cost,
          quotaExempt: false
        };
        if (allowed) {
          used += request.requestedAmount;
          reservations.set(request.idempotencyKey, row);
        }
        return row;
      }),
      markQuotaUsageAttempted: mock(async (key: string) => {
        const row = reservations.get(key);
        row.status = 'attempted';
        return row;
      }),
      recordQuotaUsageActual: mock(async () => {}),
      commitQuotaUsage: mock(async (key: string, amount: number) => {
        const row = reservations.get(key);
        row.status = 'committed';
        row.actualAmount = amount;
        return row;
      })
    };
    const middleware = new QuotaMiddleware(
      admin as any,
      {
        getUserRoleTier: async () => 'member'
      } as any
    );
    let finish!: () => void;
    const held = new Promise<void>(resolve => {
      finish = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const generate = mock(async () => {
      expect(reservations.get(`discord:first:${name}`)?.status).toBe('attempted');
      started();
      await held;
      return { url: 'https://cdn.example.com/allowed', moderationPassed: true };
    });
    const provider = { name: 'xai', generateImage: generate, generateVideo: generate };
    const executor = (operationKey: string) =>
      createProviderToolExecutor({
        preferredProviderName: 'xai',
        registry: {
          getImageProvider: () => provider,
          getVideoProvider: () => provider,
          getConfiguredImageModel: () => 'image-model',
          getConfiguredVideoModel: () => 'video-model'
        },
        quota: {
          middleware,
          operationKey,
          guildId: 'guild',
          userId: 'user',
          member: {},
          referenceImageCount: 2
        }
      } as any);
    const request = { name, input: { prompt: 'a scene' } };
    const first = executor('discord:first')(request);
    await ready;
    // Release the first request after starting the contenders, so the test also
    // terminates against an executor that incorrectly bypasses reservations.
    const second = executor('discord:second')(request);
    const duplicate = executor('discord:first')(request);
    finish();
    const results = await Promise.all([first, second, duplicate]);
    expect(results.map(r => r.status)).toEqual(['success', 'error', 'error']);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(admin.markQuotaUsageAttempted).toHaveBeenCalledTimes(1);
    expect(admin.commitQuotaUsage).toHaveBeenCalledWith(`discord:first:${name}`, cost);
    expect(used).toBe(cost);
  });
}
