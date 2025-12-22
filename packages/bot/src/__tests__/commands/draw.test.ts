/**
 * Tests for Draw Command
 *
 * Tests image generation command with various options
 * and error handling.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockInteraction, createMockProviderRegistry } from '@silo/core/test-setup';
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
      expect(command.data.description).toBe('Generate an image with AI');
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
      expect(reply).toContain('Error:');
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
});
