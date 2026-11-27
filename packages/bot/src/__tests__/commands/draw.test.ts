import { DiscordAPIError, GuildMember, RESTJSONErrorCodes } from 'discord.js';
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
import { ImageQuotaSettlementPendingError } from '../../middleware/quota';
import { ImageModelRejectedBeforeGenerationError } from '../../providers/image-rejection';
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
    test('uses xAI defaults and credits when OpenAI is unavailable', async () => {
      mockRegistry.getAvailableProviders = mock(() => ({ image: ['xai'] }));
      const generateImage = mock(async (_prompt: string, _options: Record<string, unknown>) => ({
        url: 'data:image/png;base64,AQID'
      }));
      mockRegistry.getImageProvider = mock(() => ({ name: 'xai', generateImage }));
      const executeReserved = mock(async (request: any) => ({
        allowed: true,
        value: await request.execute()
      }));
      command = new DrawCommand(mockRegistry, { executeReserved } as never);
      await command.execute(createMockInteraction({ options: { prompt: 'A sunset' } }) as never);
      expect(executeReserved.mock.calls[0]?.[0].requestedAmount).toBe(2);
      expect(generateImage.mock.calls[0]?.[1]).toMatchObject({ model: 'grok-imagine-image' });
      const explicit = createMockInteraction({
        options: { prompt: 'A sunset', model: 'gpt-image-2.5-flare' }
      });
      await command.execute(explicit as never);
      expect(explicit._getReplies()[0]).toMatchObject({
        content: expect.stringContaining('selected image provider is unavailable'),
        ephemeral: true
      });
      expect(executeReserved).toHaveBeenCalledTimes(1);
    });

    test.each([null, 'gpt-image-2.5-flare', 'gpt-image-1', 'gpt-image-1.5'])(
      'routes requested model %s to Flare at the basic OpenAI cost',
      async selectedModel => {
        const costs: number[] = [];
        const provider = {
          name: 'openai',
          generateImage: mock(async (_prompt: string, _options: Record<string, unknown>) => ({
            url: 'data:image/png;base64,AQID'
          }))
        };
        mockRegistry.getImageProvider = mock(() => provider);
        mockRegistry.getConfiguredImageModel = mock(() => 'gpt-image-1');
        command = new DrawCommand(mockRegistry, {
          executeReserved: async (request: any) => {
            costs.push(request.requestedAmount);
            await request.beforeAttempt();
            return { allowed: true, value: await request.execute() };
          }
        } as any);
        const options: Record<string, string> = { prompt: 'A sunset' };
        if (selectedModel) options.model = selectedModel;
        await command.execute(createMockInteraction({ options }) as any);
        expect(costs).toEqual([1]);
        expect(provider.generateImage).toHaveBeenCalledTimes(1);
        expect(provider.generateImage.mock.calls[0]?.[1]).toMatchObject({
          model: 'gpt-image-2.5-flare',
          size: '1024x1024',
          quality: 'auto'
        });
      }
    );

    test('passes a configured Flare snapshot to the provider at the basic cost', async () => {
      const model = 'gpt-image-2.5-flare-2026-09-08';
      const provider = {
        name: 'openai',
        generateImage: mock(async () => ({ url: 'data:image/png;base64,AQID' }))
      };
      mockRegistry.getImageProvider = mock(() => provider);
      mockRegistry.getConfiguredImageModel = mock(() => model);
      const executeReserved = mock(
        async (request: { requestedAmount: number; execute: () => Promise<unknown> }) => {
          expect(request.requestedAmount).toBe(1);
          return { allowed: true, value: await request.execute() };
        }
      );
      command = new DrawCommand(mockRegistry, { executeReserved } as never);
      await command.execute(createMockInteraction({ options: { prompt: 'A sunset' } }) as never);
      expect(provider.generateImage).toHaveBeenCalledWith(
        'A sunset',
        expect.objectContaining({ model })
      );
    });

    test('rejects unknown configured OpenAI model before reserving or calling provider', async () => {
      const provider = { name: 'openai', generateImage: mock(async () => ({ url: 'unused' })) };
      const executeReserved = mock(async () => ({ allowed: true }));
      mockRegistry.getImageProvider = mock(() => provider);
      mockRegistry.getConfiguredImageModel = mock(() => 'unsupported-model');
      command = new DrawCommand(mockRegistry, { executeReserved } as any);
      const interaction = createMockInteraction({ options: { prompt: 'A sunset' } });
      await command.execute(interaction as any);
      expect(executeReserved).not.toHaveBeenCalled();
      expect(provider.generateImage).not.toHaveBeenCalled();
      expect(interaction._getReplies()[0]).toContain('unavailable due to configuration');
      expect(JSON.stringify(interaction._getReplies())).not.toContain('unsupported-model');
    });

    test.each([
      ['gpt-image-2.5-flare', { resolution: '2k' }],
      ['gpt-image-2.5-flare', { 'aspect-ratio': '16:9' }],
      ['grok-imagine-image', { size: '1024x1024' }],
      ['grok-imagine-image', { quality: 'high' }]
    ])('rejects unsupported %s option without paid work', async (model, option) => {
      const executeReserved = mock(async () => ({ allowed: true }));
      command = new DrawCommand(mockRegistry, { executeReserved } as any);
      const interaction = createMockInteraction({
        options: { prompt: 'A sunset', model, ...option }
      });
      await command.execute(interaction as any);
      expect(executeReserved).not.toHaveBeenCalled();
      expect(mockRegistry.getImageProvider).not.toHaveBeenCalled();
      expect(interaction._getReplies()[0]).toMatchObject({ ephemeral: true });
    });

    test.each([
      ['gpt-image-2.5-flare', 'high', '1k', 2],
      ['gpt-image-2.5-flare', 'auto', '2k', 1],
      ['grok-imagine-image', 'auto', '1k', 2],
      ['grok-imagine-image', 'auto', '2k', 3]
    ])('keeps %s option cost policy', async (model, quality, resolution, expectedCost) => {
      const costs: number[] = [];
      const provider = {
        name: model === 'grok-imagine-image' ? 'xai' : 'openai',
        generateImage: mock(async () => ({ url: 'data:image/png;base64,AQID' }))
      };
      mockRegistry.getImageProvider = mock(() => provider);
      command = new DrawCommand(mockRegistry, {
        executeReserved: async (request: any) => {
          costs.push(request.requestedAmount);
          await request.beforeAttempt();
          return { allowed: true, value: await request.execute() };
        }
      } as any);
      const interaction = createMockInteraction({ options: { prompt: 'A sunset' } });
      await (command as any).generateImage(
        {
          prompt: 'A sunset',
          model,
          size: '1024x1024',
          quality,
          aspectRatio: '1:1',
          resolution,
          references: []
        },
        { messageType: 'slash-command', commandName: 'draw' },
        interaction,
        new AbortController().signal
      );
      expect(costs).toEqual([expectedCost]);
    });

    test('recomputes legacy session edit and regeneration costs with the effective model', async () => {
      const costs: number[] = [];
      const provider = {
        name: 'openai',
        generateImage: mock(async (_prompt: string, _options: Record<string, unknown>) => ({
          url: 'data:image/png;base64,AQID'
        }))
      };
      mockRegistry.getImageProvider = mock(() => provider);
      mockRegistry.getConfiguredImageModel = mock(() => 'gpt-image-1.5');
      command = new DrawCommand(mockRegistry, {
        executeReserved: async (request: any) => {
          costs.push(request.requestedAmount);
          await request.beforeAttempt();
          return { allowed: true, value: await request.execute() };
        }
      } as any);
      const interaction = createMockInteraction({ options: { prompt: 'A sunset' } });
      const session = {
        prompt: 'A sunset',
        model: 'gpt-image-1',
        size: '1024x1024',
        quality: 'auto',
        aspectRatio: '1:1',
        resolution: '1k',
        references: ['data:image/png;base64,AQID']
      };
      await (command as any).generateImage(
        session,
        { messageType: 'button-interaction', commandName: 'draw_edit' },
        interaction,
        new AbortController().signal
      );
      session.references = [];
      await (command as any).generateImage(
        session,
        { messageType: 'button-interaction', commandName: 'draw_regen' },
        interaction,
        new AbortController().signal
      );
      expect(costs).toEqual([2, 1]);
      expect(provider.generateImage.mock.calls[0]?.[1]).toMatchObject({
        model: 'gpt-image-2.5-flare',
        action: 'edit',
        referenceImages: ['data:image/png;base64,AQID']
      });
      expect(provider.generateImage.mock.calls[1]?.[1]).toMatchObject({
        model: 'gpt-image-2.5-flare',
        action: 'generate',
        referenceImages: []
      });
    });
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

    test.each([
      [401, 'provider access needs attention'],
      [404, 'unavailable for this model'],
      [429, 'temporarily unavailable from the provider']
    ])('classifies provider status %s without exposing raw errors', async (status, expected) => {
      const provider = {
        name: 'openai',
        generateImage: mock(async () => {
          const cause = Object.assign(new Error('private provider detail'), { status });
          throw new Error('OpenAI image generation failed', { cause });
        })
      };
      mockRegistry.getImageProvider = mock(() => provider);
      const interaction = createMockInteraction({ options: { prompt: 'A sunset' } });
      await command.execute(interaction as any);
      expect(interaction._getReplies()[0]).toContain(expected);
      expect(JSON.stringify(interaction._getReplies())).not.toContain('private provider detail');
    });

    test('preserves a credit-settlement warning when the image deadline expires', async () => {
      const deadline = new AbortController();
      const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
      mockRegistry.getImageProvider = mock(() => ({ name: 'openai' }));
      command = new DrawCommand(mockRegistry, {
        executeReserved: async () => {
          deadline.abort();
          throw new ImageQuotaSettlementPendingError(
            new ImageModelRejectedBeforeGenerationError({
              provider: 'openai',
              status: 404,
              code: 'model_not_found',
              requestId: 'req_synthetic_3'
            })
          );
        }
      } as never);
      try {
        const interaction = createMockInteraction({ options: { prompt: 'A sunset' } });
        await command.execute(interaction as never);
        const replies = JSON.stringify(interaction._getReplies());
        expect(replies).toContain('Credit settlement needs review');
        expect(replies).not.toContain('req_synthetic_3');
      } finally {
        timeout.mockRestore();
      }
    });

    test('renders a definitive model rejection without exposing provider evidence', async () => {
      mockRegistry.getImageProvider = mock(() => ({
        name: 'openai',
        generateImage: mock(async () => {
          throw new ImageModelRejectedBeforeGenerationError({
            provider: 'openai',
            status: 400,
            code: 'model_not_found',
            requestId: 'req_synthetic_1'
          });
        })
      }));
      const interaction = createMockInteraction({ options: { prompt: 'A sunset' } });
      await command.execute(interaction as any);
      const replies = JSON.stringify(interaction._getReplies());
      expect(replies).toContain('unavailable for this model');
      expect(replies).not.toContain('req_synthetic_1');
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
      const editError = new DiscordAPIError(
        { message: 'Unknown Message', code: RESTJSONErrorCodes.UnknownMessage },
        RESTJSONErrorCodes.UnknownMessage,
        404,
        'PATCH',
        'https://discord.com/api/v10/channels/test/messages/test',
        {}
      );

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
          errorType: editError.name
        });

        expect(interaction.editReply).toHaveBeenCalledWith({
          content: expect.stringContaining('The original Discord message is gone. Run /draw')
        });
      } finally {
        (logger as any).warn = originalWarn;
      }
    });
  });
});
