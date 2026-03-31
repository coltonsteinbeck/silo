import OpenAI from 'openai';
import type {
  TextProvider,
  ImageProvider,
  VideoProvider,
  Message,
  TextGenerationOptions,
  TextGenerationResponse,
  ImageGenerationOptions,
  ImageGenerationResponse,
  VideoGenerationOptions,
  VideoGenerationResponse,
  ImageAnalysisOptions,
  ImageAnalysisResponse
} from '@silo/core';

/**
 * xAI/Grok provider using OpenAI-compatible API
 * https://docs.x.ai/api
 * Supports text generation and image understanding.
 */
export class XAIProvider implements TextProvider, ImageProvider, VideoProvider {
  name = 'xai';
  capabilities = {
    vision: true,
    maxImagesPerRequest: 1,
    maxImageReferences: 5,
    maxVideoReferences: 7,
    videoGeneration: true
  };
  private client: OpenAI | null = null;
  private apiKey: string | null = null;
  private baseUrl: string;
  private defaultModel: string;
  private defaultImageModel: string;
  private defaultVideoModel: string;

  constructor(
    apiKey?: string,
    model: string = 'grok-4-1-fast-non-reasoning',
    imageModel: string = 'grok-imagine-image',
    videoModel: string = 'grok-imagine-video',
    baseURL: string = 'https://api.x.ai/v1'
  ) {
    this.defaultModel = model;
    this.defaultImageModel = imageModel;
    this.defaultVideoModel = videoModel;
    this.baseUrl = baseURL.replace(/\/$/, '');
    if (apiKey) {
      this.apiKey = apiKey;
      this.client = new OpenAI({
        apiKey,
        baseURL: this.baseUrl,
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

  private async requestJson<T>(
    path: string,
    init: NonNullable<Parameters<typeof fetch>[1]>
  ): Promise<T> {
    if (!this.apiKey) {
      throw new Error('xAI provider not configured');
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.headers || {})
      }
    });

    if (!response.ok) {
      const body = await response.text();

      let parsedBody: any;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = undefined;
      }

      const parsedError =
        parsedBody?.error?.message ||
        parsedBody?.error ||
        parsedBody?.message ||
        parsedBody?.detail;

      if (typeof parsedError === 'string') {
        const lowered = parsedError.toLowerCase();
        if (lowered.includes('content moderation') || lowered.includes('moderation')) {
          throw new Error(
            'xAI rejected this image request due to content moderation. Try a safer, less explicit prompt or edit instruction.'
          );
        }

        throw new Error(`xAI API error (${response.status}): ${parsedError}`);
      }

      throw new Error(`xAI API error (${response.status}): ${body.slice(0, 300)}`);
    }

    return (await response.json()) as T;
  }

  private normalizeResolution(resolution: string): string {
    const normalized = resolution.trim().toLowerCase();
    return normalized;
  }

  async generateImage(
    prompt: string,
    options?: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    const references = options?.referenceImages || [];

    const payload: Record<string, unknown> = {
      model: options?.model || this.defaultImageModel,
      prompt,
      image_format: 'url'
    };

    if (options?.aspectRatio) {
      payload.aspect_ratio = options.aspectRatio;
    }
    if (options?.resolution) {
      payload.resolution = this.normalizeResolution(options.resolution);
    }

    if (references.length === 1) {
      payload.image_url = references[0];
    } else if (references.length > 1) {
      payload.image_urls = references;
    }

    const response = await this.requestJson<any>('/images/generations', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const imageEntry = response?.data?.[0] || response?.images?.[0] || response?.image || response;
    const url = imageEntry?.url || response?.url;

    if (!url || typeof url !== 'string') {
      throw new Error('xAI image generation returned no URL');
    }

    return {
      url,
      revisedPrompt: imageEntry?.revised_prompt,
      model: imageEntry?.model || payload.model?.toString(),
      moderationPassed:
        typeof imageEntry?.respect_moderation === 'boolean' ? imageEntry.respect_moderation : true
    };
  }

  async generateVideo(
    prompt: string,
    options?: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    const payload: Record<string, unknown> = {
      model: options?.model || this.defaultVideoModel,
      prompt,
      duration: options?.duration ?? 8
    };

    if (options?.aspectRatio) {
      payload.aspect_ratio = options.aspectRatio;
    }
    if (options?.resolution) {
      payload.resolution = this.normalizeResolution(options.resolution);
    }

    const references = options?.referenceImages || [];
    if (references.length === 1) {
      payload.image_url = references[0];
    } else if (references.length > 1) {
      payload.reference_image_urls = references;
    }

    const start = await this.requestJson<{ request_id?: string }>('/videos/generations', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const requestId = start.request_id;
    if (!requestId) {
      throw new Error('xAI video generation did not return request_id');
    }

    const timeoutMs = 12 * 60 * 1000;
    const pollIntervalMs = 2500;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.requestJson<any>(`/videos/${encodeURIComponent(requestId)}`, {
        method: 'GET'
      });

      const state = String(status?.status || '').toLowerCase();
      if (state === 'done') {
        const video = status.video || {};
        const url = video.url;
        if (!url || typeof url !== 'string') {
          throw new Error('xAI video generation completed without a URL');
        }

        return {
          url,
          model: status.model || payload.model?.toString(),
          duration: typeof video.duration === 'number' ? video.duration : undefined,
          moderationPassed:
            typeof video.respect_moderation === 'boolean' ? video.respect_moderation : true
        };
      }

      if (state === 'failed') {
        throw new Error(status?.error?.message || 'xAI video generation failed');
      }

      if (state === 'expired') {
        throw new Error('xAI video generation request expired');
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('xAI video generation timed out');
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
