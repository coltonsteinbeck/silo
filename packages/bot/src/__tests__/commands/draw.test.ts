import { GuildMember } from 'discord.js';
import * as mediaDownload from '../../services/media-download';
/**
 * Tests for Draw Command
 *
 * Tests image generation command with various options
 * and error handling.
 */

import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  createMockInteraction as createBaseInteraction,
  createMockProviderRegistry
} from '@silo/core/test-setup';
import { logger } from '@silo/core';
import { DrawCommand } from '../../commands/draw';
import type { PromptModerationGuard } from '../../security/command-prompt-moderation';

function createMockInteraction(options?: Parameters<typeof createBaseInteraction>[0]) {
  const interaction = createBaseInteraction(options);
  Object.assign(interaction, {
    id: 'interaction',
    member: Object.assign(Object.create(GuildMember.prototype), {
      user: interaction.user,
      guild: { id: interaction.guildId }
    })
  });
  return interaction;
}
const testQuota = {
  executeReserved: async (p: any) => {
    await p.beforeAttempt();
    return { allowed: true, value: await p.execute(p.requestedAmount) };
  }
};

describe('DrawCommand', () => {
  test('shutdown does not intercept unrelated buttons or modals', async () => {
    const controller = new AbortController();
    controller.abort(new Error('shutdown'));
    const command = new DrawCommand(
      createMockProviderRegistry() as any,
      undefined,
      undefined,
      undefined,
      controller.signal
    );
    expect(await command.handleButtonInteraction({ customId: 'radio_skip:guild' } as never)).toBe(
      false
    );
    expect(await command.handleModalSubmit({ customId: 'other_modal:id' } as never)).toBe(false);
    await expect(
      command.handleButtonInteraction({ customId: 'draw_retry:id' } as never)
    ).rejects.toThrow('shutdown');
    await expect(command.handleModalSubmit({ customId: 'draw_modal:id' } as never)).rejects.toThrow(
      'shutdown'
    );
  });

  let command: DrawCommand;

  let mockRegistry: any;
  const originalFetch = globalThis.fetch;
  let downloadSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    downloadSpy = spyOn(mediaDownload, 'downloadMedia').mockImplementation(async url => {
      const response = await globalThis.fetch(url);
      if (!response.ok) throw new Error('Download failed');
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') || ''
      };
    });
    globalThis.fetch = mock(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'content-type': 'image/png',
          'content-length': '3'
        }
      });
    }) as unknown as typeof fetch;
    mockRegistry = createMockProviderRegistry();
    command = new DrawCommand(mockRegistry, testQuota as any);
  });

  afterEach(() => {
    downloadSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  describe('data', () => {
    test('has correct name', () => {
      expect(command.data.name).toBe('draw');
    });

    test('has correct description', () => {
      expect(command.data.description).toBe('Generate or edit images with multiple image models');
    });
  });

  describe('execute', () => {
    test.each(['gemini-3.1-flash-image-preview', 'unknown', '__proto__', 'constructor'])(
      'rejects obsolete or forged model %s before paid work',
      async model => {
        const promptGuard = mock(async () => ({ allowed: true, processedPrompt: 'A sunset' }));
        const quota = { checkQuota: mock(async () => true) };
        command = new DrawCommand(mockRegistry, quota as any, undefined, promptGuard);
        const interaction = createMockInteraction({ options: { prompt: 'A sunset', model } });
        await command.execute(interaction as any);
        expect(interaction._getReplies()).toEqual([
          {
            content: 'This image model is no longer available. Choose a current model from /draw.',
            ephemeral: true
          }
        ]);
        expect(promptGuard).not.toHaveBeenCalled();
        expect(mockRegistry.getImageProvider).not.toHaveBeenCalled();
        expect(quota.checkQuota).not.toHaveBeenCalled();
      }
    );
    test('defers reply before processing', async () => {
      const interaction = createMockInteraction({
        options: {
          prompt: 'A beautiful sunset'
        }
      });

      await command.execute(interaction as any);

      expect(interaction.deferReply).toHaveBeenCalled();
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
      command = new DrawCommand(mockRegistry, testQuota as any, security as any);

      const interaction = createMockInteraction({
        options: {
          prompt: 'Use this reference'
        },
        guildId: 'guild-1',
        channelId: 'channel-1'
      }) as any;

      interaction.user = { id: 'user-1' };

      interaction.options.getAttachment = mock((name: string) => {
        if (name === 'reference1') {
          return {
            contentType: 'image/png',
            url: 'https://bit.ly/example-ref'
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
      expect(interaction.editReply).toHaveBeenCalled();
    });

    test('generates image with prompt', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => ({
          url: 'https://example.com/image.png',
          revisedPrompt: 'A beautiful sunset over mountains'
        }))
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: 'A beautiful sunset'
        }
      });

      await command.execute(interaction as any);

      expect(mockProvider.generateImage).toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalled();
    });

    test('uses default size when not specified', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async (_prompt: string, opts: { size: string }) => {
          expect(opts.size).toBe('1024x1024');
          return { url: 'https://example.com/image.png' };
        })
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: 'Test prompt'
        }
      });

      await command.execute(interaction as any);
    });

    test('uses specified size', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async (_prompt: string, opts: { size: string }) => {
          expect(opts.size).toBe('1792x1024');
          return { url: 'https://example.com/image.png' };
        })
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: 'Test prompt',
          size: '1792x1024'
        }
      });

      await command.execute(interaction as any);
    });

    test('uses specified quality', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async (_prompt: string, opts: { quality: string }) => {
          expect(opts.quality).toBe('high');
          return { url: 'https://example.com/image.png' };
        })
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: 'Test prompt',
          quality: 'high'
        }
      });

      await command.execute(interaction as any);
    });

    test('handles no provider configured', async () => {
      mockRegistry.getImageProvider = mock(() => null);

      const interaction = createMockInteraction({
        options: {
          prompt: 'Test prompt'
        }
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toContain('Error generating image:');
      expect(reply).toContain('Image generation failed. Please try again in a moment.');
    });

    test('handles provider error gracefully', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => {
          throw new Error('API rate limit exceeded');
        })
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: 'Test prompt'
        }
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0];
      expect(reply).toContain('Error generating image:');
      expect(reply).toContain('Image generation failed. Please try again in a moment.');
      expect(reply).not.toContain('API rate limit exceeded');
    });

    test('blocks prompt via moderation preflight before provider call', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => ({
          url: 'https://example.com/image.png'
        }))
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const blockedGuard = mock(async () => ({
        allowed: false,
        processedPrompt: '',
        userMessage: '⚠️ Prompt blocked by content policy. Please rephrase with safer wording.'
      }));

      command = new DrawCommand(mockRegistry, testQuota as any, undefined, blockedGuard as any);

      const interaction = createMockInteraction({
        options: {
          prompt: 'unsafe prompt'
        }
      });

      await command.execute(interaction as any);

      expect(mockProvider.generateImage).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalled();
    });

    test('uses moderation processedPrompt when provider generation is allowed', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => ({
          url: 'https://example.com/image.png'
        }))
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const promptGuard: PromptModerationGuard = mock(async () => ({
        allowed: true,
        processedPrompt: 'sanitized text'
      })) as unknown as PromptModerationGuard;

      command = new DrawCommand(mockRegistry, testQuota as any, undefined, promptGuard);

      const interaction = createMockInteraction({
        options: {
          prompt: 'original unsafe-ish prompt'
        }
      });

      await command.execute(interaction as any);

      expect(mockProvider.generateImage).toHaveBeenCalled();
      const firstCall = (mockProvider.generateImage as any).mock.calls[0];
      expect(firstCall?.[0]).toBe('sanitized text');
      expect(firstCall?.[0]).not.toBe('original unsafe-ish prompt');
    });

    test('handles moderation guard errors without crashing and replies safely', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => ({
          url: 'https://example.com/image.png'
        }))
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const throwingGuard: PromptModerationGuard = mock(async () => {
        throw new Error('moderation backend unavailable');
      }) as unknown as PromptModerationGuard;

      command = new DrawCommand(mockRegistry, testQuota as any, undefined, throwingGuard);

      const interaction = createMockInteraction({
        options: {
          prompt: 'original prompt'
        }
      });

      await expect(command.execute(interaction as any)).resolves.toBeUndefined();
      expect(interaction.editReply).toHaveBeenCalled();
      expect(mockProvider.generateImage).not.toHaveBeenCalled();

      const replyPayload = (interaction.editReply as any).mock.calls[0]?.[0];
      expect(replyPayload?.content).toContain('Prompt validation is temporarily unavailable');
    });

    test('delivers generated image as an attachment without prompt metadata or provider URL', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => ({
          url: 'https://example.com/image.png',
          revisedPrompt: 'Enhanced: A beautiful sunset with vibrant colors'
        }))
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: 'sunset'
        }
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0] as { embeds?: any[]; files?: any[] };
      expect(reply.embeds).toEqual([]);
      expect(reply.files).toHaveLength(1);
      expect(JSON.stringify(reply)).not.toContain('https://example.com/image.png');
      expect(JSON.stringify(reply)).not.toContain('Enhanced');
    });

    test('does not expose mass mentions or revised prompt text in image response', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => ({
          url: 'https://example.com/image.png',
          revisedPrompt: '@everyone review this image'
        }))
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: '@here draw a banner'
        }
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0] as { embeds?: any[]; files?: any[] };
      expect(reply.embeds).toEqual([]);
      expect(reply.files).toHaveLength(1);
      expect(JSON.stringify(reply)).not.toContain('@everyone');
      expect(JSON.stringify(reply)).not.toContain('@here');
      expect(JSON.stringify(reply)).not.toContain('review this image');
    });

    test('does not show provider URL when no revised prompt', async () => {
      const mockProvider = {
        name: 'openai',
        isConfigured: () => true,
        generateImage: mock(async () => ({
          url: 'https://example.com/image.png'
        }))
      };
      mockRegistry.getImageProvider = mock(() => mockProvider);

      const interaction = createMockInteraction({
        options: {
          prompt: 'sunset'
        }
      });

      await command.execute(interaction as any);

      const reply = interaction._getReplies()[0] as { embeds?: any[]; files?: any[] };
      expect(reply.embeds).toEqual([]);
      expect(reply.files).toHaveLength(1);
      expect(JSON.stringify(reply)).not.toContain('https://example.com/image.png');
      expect(JSON.stringify(reply)).not.toContain('sunset');
    });
  });

  describe('handleModalSubmit', () => {
    test('reports failure when original message edit fails and logs warning context', async () => {
      const sessionId = 'session-1';
      const messageId = 'message-1';
      const editError = new Error('message no longer editable');

      const warnMock = mock(() => {});
      const originalWarn = logger.warn;
      (logger as any).warn = warnMock;

      const commandAny = command as any;
      commandAny.generateImage = mock(async () => ({
        files: [],
        uploaded: true
      }));
      commandAny.createControls = mock(() => []);

      commandAny.sessions.set(sessionId, {
        id: sessionId,
        userId: '111222333',
        channelId: 'channel-1',
        messageId,
        createdAt: Date.now(),
        prompt: 'before',
        model: 'gpt-image-1',
        size: '1024x1024',
        quality: 'auto',
        aspectRatio: '1:1',
        resolution: '1k',
        references: [],
        quotaCost: 1
      });

      const interaction = createMockInteraction({
        userId: '111222333',
        guildId: 'guild-1',
        channelId: 'channel-1'
      }) as any;

      interaction.customId = `draw_modal:${sessionId}`;
      interaction.fields = {
        getTextInputValue: mock(() => 'after')
      };

      interaction.channel = {
        messages: {
          fetch: mock(async () => ({
            edit: mock(async () => {
              throw editError;
            })
          }))
        }
      };

      try {
        await expect(command.handleModalSubmit(interaction)).resolves.toBe(true);

        expect(warnMock).toHaveBeenCalled();
        const warnCall = (warnMock as any).mock.calls[0];
        expect(warnCall?.[0]).toContain('Failed to edit original draw message');
        expect(warnCall?.[1]).toMatchObject({
          sessionId,
          messageId,
          error: editError
        });

        expect(interaction.editReply).toHaveBeenCalledWith({
          content: expect.stringContaining('Image edit failed:')
        });
      } finally {
        (logger as any).warn = originalWarn;
      }
    });
  });
});
