import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockInteraction, createMockProviderRegistry } from '@silo/core/test-setup';
import { VideoCommand } from '../../commands/video';

describe('VideoCommand', () => {
  let registry: any;
  let command: VideoCommand;

  beforeEach(() => {
    registry = createMockProviderRegistry();
    command = new VideoCommand(registry);
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
});
