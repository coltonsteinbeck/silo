import OpenAI from 'openai';
import type {
  TextProvider,
  ImageProvider,
  Message,
  TextGenerationOptions,
  TextGenerationResponse,
  ImageGenerationOptions,
  ImageGenerationResponse,
  ImageAnalysisOptions,
  ImageAnalysisResponse
} from '@silo/core';

/**
 * xAI/Grok provider using OpenAI-compatible API
 * https://docs.x.ai/api
 * Supports text generation and image understanding.
 */
export class XAIProvider implements TextProvider, ImageProvider {
  name = 'xai';
  private client: OpenAI | null = null;
  private defaultModel: string;

  constructor(apiKey?: string, model: string = 'grok-4-1-fast-non-reasoning') {
    this.defaultModel = model;
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: 'https://api.x.ai/v1',
        timeout: 60000
      });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async generateText(
    messages: Message[],
    options?: TextGenerationOptions
  ): Promise<TextGenerationResponse> {
    if (!this.client) {
      throw new Error('xAI provider not configured');
    }

    const response = await this.client.chat.completions.create({
      model: options?.model || this.defaultModel,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      temperature: options?.temperature ?? 0.8,
      max_tokens: options?.maxTokens ?? 1024,
      stream: false
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from xAI');
    }

    return {
      content: choice.message.content,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          }
        : undefined,
      model: response.model
    };
  }

  async generateImage(
    _prompt: string,
    _options?: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    throw new Error('xAI does not support image generation. Use OpenAI instead.');
  }

  async analyzeImage(
    imageUrl: string,
    prompt: string,
    options?: ImageAnalysisOptions
  ): Promise<ImageAnalysisResponse> {
    if (!this.client) {
      throw new Error('xAI provider not configured');
    }

    const response = await this.client.chat.completions.create({
      model: options?.model || this.defaultModel,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url' as const,
              image_url: {
                url: imageUrl,
                detail: 'high' as const
              }
            },
            {
              type: 'text' as const,
              text: prompt
            }
          ]
        }
      ],
      max_tokens: options?.maxTokens ?? 1024,
      stream: false
    } as any);

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from xAI vision');
    }

    return {
      content: choice.message.content,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          }
        : undefined
    };
  }
}
