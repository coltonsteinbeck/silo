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
  ImageAnalysisResponse,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchResponse
} from '@silo/core';
import { normalizeTextGenerationFinishReason } from './finish-reason';

interface XAIErrorResponse {
  error?: string | { message?: string };
  message?: string;
  detail?: string;
}

interface XAIImageEntry {
  url?: string;
  revised_prompt?: string;
  model?: string;
  respect_moderation?: boolean;
}

interface XAIImageResponse {
  data?: XAIImageEntry[];
  images?: XAIImageEntry[];
  image?: XAIImageEntry;
  url?: string;
}

interface XAIVideoStatusResponse {
  status?: string;
  model?: string;
  video?: {
    url?: string;
    duration?: number;
    respect_moderation?: boolean;
  };
  error?: string | { message?: string };
}

interface XAIResponsesAnnotation {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface XAIResponsesContentItem {
  type?: string;
  text?: string;
  annotations?: XAIResponsesAnnotation[];
}

interface XAIResponsesOutputItem {
  type?: string;
  content?: XAIResponsesContentItem[];
}

interface XAIResponsesRequest {
  model: string;
  input: Array<{
    role: 'user';
    content: string;
  }>;
  tools: Array<{
    type: 'web_search';
  }>;
  stream: false;
}

interface XAIResponsesResult {
  output_text?: string;
  output?: XAIResponsesOutputItem[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function assertValidXAIResponsesRequest(request: XAIResponsesRequest): void {
  if (!request.model.trim()) {
    throw new Error('xAI web search requires a model');
  }

  for (const tool of request.tools) {
    if (tool.type !== 'web_search') {
      throw new Error(`Unsupported xAI responses tool type: ${String(tool.type)}`);
    }
  }
}

/**
 * xAI/Grok provider using OpenAI-compatible API
 * https://docs.x.ai/api
 * Supports text generation and image understanding.
 */
export class XAIProvider implements TextProvider, ImageProvider, VideoProvider, WebSearchProvider {
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
    model: string = 'grok-4.20-non-reasoning',
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
      model: response.model,
      finishReason: normalizeTextGenerationFinishReason(choice.finish_reason),
      providerFinishReason: choice.finish_reason || undefined
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

      let parsedBody: XAIErrorResponse | undefined;
      try {
        parsedBody = JSON.parse(body) as XAIErrorResponse;
      } catch {
        parsedBody = undefined;
      }

      const parsedError =
        (typeof parsedBody?.error === 'string' ? parsedBody.error : parsedBody?.error?.message) ||
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

    const payload: {
      model: string;
      prompt: string;
      image_format: 'url';
      aspect_ratio?: string;
      resolution?: string;
      image_url?: string;
      image_urls?: string[];
    } = {
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

    const response = await this.requestJson<XAIImageResponse>('/images/generations', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const imageEntry: XAIImageEntry | undefined =
      response.data?.[0] || response.images?.[0] || response.image;
    const url = imageEntry?.url || response.url;

    if (!url || typeof url !== 'string') {
      throw new Error('xAI image generation returned no URL');
    }

    return {
      url,
      revisedPrompt: imageEntry?.revised_prompt,
      model: imageEntry?.model || payload.model,
      moderationPassed: imageEntry?.respect_moderation ?? true
    };
  }

  async generateVideo(
    prompt: string,
    options?: VideoGenerationOptions
  ): Promise<VideoGenerationResponse> {
    const payload: {
      model: string;
      prompt: string;
      duration: number;
      aspect_ratio?: string;
      resolution?: string;
      image_url?: string;
      reference_image_urls?: string[];
    } = {
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
      const status = await this.requestJson<XAIVideoStatusResponse>(
        `/videos/${encodeURIComponent(requestId)}`,
        {
          method: 'GET'
        }
      );

      const state = String(status?.status || '').toLowerCase();
      if (state === 'done') {
        const video = status.video || {};
        const url = video.url;
        if (!url || typeof url !== 'string') {
          throw new Error('xAI video generation completed without a URL');
        }

        return {
          url,
          model: status.model || payload.model,
          duration: typeof video.duration === 'number' ? video.duration : undefined,
          moderationPassed: video.respect_moderation ?? true
        };
      }

      if (state === 'failed') {
        const message = typeof status.error === 'string' ? status.error : status.error?.message;
        throw new Error(message || 'xAI video generation failed');
      }

      if (state === 'expired') {
        throw new Error('xAI video generation request expired');
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error('xAI video generation timed out');
  }

  async searchWeb(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
    const request: XAIResponsesRequest = {
      model: options?.model?.trim() || this.defaultModel,
      input: [{ role: 'user', content: query }],
      tools: [{ type: 'web_search' }],
      stream: false
    };

    assertValidXAIResponsesRequest(request);

    const response = await this.requestJson<XAIResponsesResult>('/responses', {
      method: 'POST',
      body: JSON.stringify(request)
    });

    const outputText =
      response.output_text ||
      (response.output || [])
        .flatMap(item => item.content || [])
        .map(item => item.text || '')
        .join('')
        .trim();

    const citations = (response.output || [])
      .flatMap(item => item.content || [])
      .flatMap(item => item.annotations || [])
      .filter(annotation => Boolean(annotation.url))
      .slice(0, options?.maxResults || 5)
      .map(annotation => ({
        url: annotation.url as string,
        title: annotation.title,
        startIndex: annotation.start_index,
        endIndex: annotation.end_index
      }));

    if (!outputText) {
      throw new Error('xAI web search returned no answer text');
    }

    return {
      content: outputText,
      citations,
      model: response.model || options?.model || this.defaultModel,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens || response.usage.prompt_tokens || 0,
            completionTokens: response.usage.output_tokens || response.usage.completion_tokens || 0,
            totalTokens: response.usage.total_tokens || 0
          }
        : undefined
    };
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
