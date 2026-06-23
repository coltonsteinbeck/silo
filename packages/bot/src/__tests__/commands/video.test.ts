import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockInteraction, createMockProviderRegistry } from '@silo/core/test-setup';
import { VideoCommand } from '../../commands/video';
import type { PromptModerationGuard } from '../../security/command-prompt-moderation';

describe('VideoCommand', () => {
  let registry: any;
  let command: VideoCommand;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: {
          'content-type': 'video/mp4',
          'content-length': '4'
        }
      });
    }) as unknown as typeof fetch;
    registry = createMockProviderRegistry();
    command = new VideoCommand(registry);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('does not expose a user option for video amount', () => {
    const json = command.data.toJSON();
    const optionNames = (json.options || []).map(option => option.name);

    expect(optionNames).not.toContain('count');
    expect(optionNames).not.toContain('amount');
    expect(optionNames).not.toContain('videos');
  });

  test('does not send a count option to provider', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://example.com/video.mp4',
      model: 'grok-imagine-video',
      duration: 8
    }));

    registry.getVideoProvider = mock(() => ({
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    }));

    const interaction = createMockInteraction({
      options: {
        prompt: 'Ocean waves'
      }
    }) as any;

    interaction.options.getAttachment = mock(() => null);

    await command.execute(interaction);

    expect(generateVideo).toHaveBeenCalled();
    const calls = (generateVideo as any).mock.calls as any[];
    const options = (calls[0]?.[1] || {}) as { count?: number };
    expect(options.count).toBeUndefined();
  });

  test('logs blocked reference URL screening events', async () => {
    const logUrlSecurityEvent = mock(async () => {});
    const security = {
      policy: {
        blockKnownShorteners: true
      },
      adminDb: {
        logUrlSecurityEvent
      }
    };

    command = new VideoCommand(registry, undefined, security as any);

    const interaction = createMockInteraction({
      options: {
        prompt: 'Animate this reference'
      },
      guildId: 'guild-1',
      channelId: 'channel-1'
    }) as any;

    interaction.user = { id: 'user-1' };

    interaction.options.getAttachment = mock((name: string) => {
      if (name === 'reference1') {
        return {
          contentType: 'image/jpeg',
          url: 'https://tinyurl.com/malicious-ref'
        };
      }
      return null;
    });

    await command.execute(interaction);

    expect(logUrlSecurityEvent).toHaveBeenCalled();
    const calls = (logUrlSecurityEvent as any).mock.calls as any[];
    const event = calls[0]?.[0] as { action?: string; reason?: string };
    expect(event.action).toBe('blocked');
    expect(event.reason).toContain('shortener');
    expect(interaction.reply).toHaveBeenCalled();
  });

  test('blocks video prompt via moderation preflight before provider call', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://example.com/video.mp4',
      model: 'grok-imagine-video',
      duration: 8
    }));

    registry.getVideoProvider = mock(() => ({
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    }));

    const blockedGuard = mock(async () => ({
      allowed: false,
      processedPrompt: '',
      userMessage: '⚠️ Prompt blocked by content policy. Please rephrase with safer wording.'
    }));

    command = new VideoCommand(registry, undefined, undefined, blockedGuard as any);

    const interaction = createMockInteraction({
      options: {
        prompt: 'unsafe prompt'
      }
    }) as any;

    interaction.options.getAttachment = mock(() => null);

    await command.execute(interaction);

    expect(generateVideo).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalled();
  });

  test('uses moderation processedPrompt when invoking video provider', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://example.com/video.mp4',
      model: 'grok-imagine-video',
      duration: 8
    }));

    registry.getVideoProvider = mock(() => ({
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    }));

    const promptGuard: PromptModerationGuard = mock(async () => ({
      allowed: true,
      processedPrompt: 'processed text'
    })) as unknown as PromptModerationGuard;

    command = new VideoCommand(registry, undefined, undefined, promptGuard);

    const interaction = createMockInteraction({
      options: {
        prompt: 'original prompt text'
      }
    }) as any;

    interaction.options.getAttachment = mock(() => null);

    await command.execute(interaction);

    expect(generateVideo).toHaveBeenCalled();
    const calls = (generateVideo as any).mock.calls as any[];
    expect(calls[0]?.[0]).toBe('processed text');
    expect(calls[0]?.[0]).not.toBe('original prompt text');
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalled();
    const reply = interaction._getReplies()[0] as { embeds?: any[]; files?: any[] };
    expect(reply.embeds).toEqual([]);
    expect(reply.files).toHaveLength(1);
    expect(JSON.stringify(reply)).not.toContain('https://example.com/video.mp4');
  });

  test('does not expose prompt text or provider URL in generated video response', async () => {
    const generateVideo = mock(async () => ({
      url: 'https://example.com/video.mp4',
      model: 'grok-imagine-video',
      duration: 8
    }));

    registry.getVideoProvider = mock(() => ({
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    }));

    const promptGuard: PromptModerationGuard = mock(async () => ({
      allowed: true,
      processedPrompt: '@everyone cinematic update'
    })) as unknown as PromptModerationGuard;

    command = new VideoCommand(registry, undefined, undefined, promptGuard);

    const interaction = createMockInteraction({
      options: {
        prompt: '@here cinematic update'
      }
    }) as any;

    interaction.options.getAttachment = mock(() => null);

    await command.execute(interaction);

    const reply = interaction._getReplies().find((entry: unknown) => {
      return typeof entry === 'object' && entry !== null && 'files' in entry;
    }) as { embeds?: any[]; files?: any[] };
    expect(reply.embeds).toEqual([]);
    expect(reply.files).toHaveLength(1);
    expect(JSON.stringify(reply)).not.toContain('@everyone');
    expect(JSON.stringify(reply)).not.toContain('@here');
    expect(JSON.stringify(reply)).not.toContain('https://example.com/video.mp4');
    expect(JSON.stringify(reply)).not.toContain('cinematic update');
  });

  test('returns short no-link failure when inline video upload fails', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(new Uint8Array([1]), {
        headers: {
          'content-type': 'video/mp4',
          'content-length': `${25 * 1024 * 1024}`
        }
      });
    }) as unknown as typeof fetch;

    const generateVideo = mock(async () => ({
      url: 'https://example.com/video.mp4',
      model: 'grok-imagine-video',
      duration: 8
    }));

    registry.getVideoProvider = mock(() => ({
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    }));

    const interaction = createMockInteraction({
      options: {
        prompt: 'safe prompt'
      }
    }) as any;

    interaction.options.getAttachment = mock(() => null);

    await command.execute(interaction);

    const reply = interaction._getReplies()[0] as { content?: string; embeds?: any[] };
    expect(reply.content).toContain('Could not upload video inline');
    expect(reply.embeds).toEqual([]);
    expect(JSON.stringify(reply)).not.toContain('https://example.com/video.mp4');
  });

  test('redacts provider errors from user-facing video failures', async () => {
    const generateVideo = mock(async () => {
      throw new Error('xAI internal provider trace with sensitive details');
    });

    registry.getVideoProvider = mock(() => ({
      name: 'xai',
      isConfigured: () => true,
      generateVideo
    }));

    const interaction = createMockInteraction({
      options: {
        prompt: 'safe prompt'
      }
    }) as any;

    interaction.options.getAttachment = mock(() => null);

    await command.execute(interaction);

    const reply = interaction._getReplies()[0] as string;
    expect(reply).toContain('Video generation failed. Please try again in a moment.');
    expect(reply).not.toContain('internal provider trace');
  });
});
