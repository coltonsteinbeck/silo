/**
 * Tests for Draw Command
 *
 * Tests image generation command with various options
 * and error handling.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockProviderRegistry } from '@silo/core/test-setup';
import { logger } from '@silo/core';
import { DrawCommand } from '../../commands/draw';

describe('DrawCommand', () => {
  let command: DrawCommand;

  let mockRegistry: any;

  beforeEach(() => {
    mockRegistry = createMockProviderRegistry();
    command = new DrawCommand(mockRegistry);
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
      command = new DrawCommand(mockRegistry, undefined, security as any);

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
      expect(interaction.reply).toHaveBeenCalled();
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
      expect(reply).toContain('No image generation provider configured');
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
      expect(reply).toContain('API rate limit exceeded');
    });

    test('includes revised prompt in response when available', async () => {
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

      const reply = interaction._getReplies()[0] as { embeds: any[] };
      expect(reply.embeds).toBeDefined();
      expect(reply.embeds[0].data.description).toContain('Enhanced');
    });

    test('shows generic success message when no revised prompt', async () => {
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

      const reply = interaction._getReplies()[0] as { embeds: any[] };
      expect(reply.embeds).toBeDefined();
      expect(reply.embeds[0].data.description).toContain('sunset');
    });
  });

  describe('handleModalSubmit', () => {
    test('continues when original message edit fails and logs warning context', async () => {
      const sessionId = 'session-1';
      const messageId = 'message-1';
      const editError = new Error('message no longer editable');

      const warnMock = mock(() => {});
      const originalWarn = logger.warn;
      (logger as any).warn = warnMock;

      const commandAny = command as any;
      commandAny.generateImage = mock(async () => ({
        embed: { data: { description: 'updated' } },
        files: []
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
          content: 'Image updated successfully.'
        });
      } finally {
        (logger as any).warn = originalWarn;
      }
    });
  });
});
