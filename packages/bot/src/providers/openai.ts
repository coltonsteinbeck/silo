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

export class OpenAIProvider implements TextProvider, ImageProvider {
  name = 'openai';
  private client: OpenAI | null = null;
  private defaultModel: string;
  private defaultImageModel: string;

  constructor(apiKey?: string, model: string = 'gpt-5-mini', imageModel: string = 'gpt-image-1') {
    this.defaultModel = model;
    this.defaultImageModel = imageModel;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
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
      throw new Error('OpenAI provider not configured');
    }

    const response = await this.client.chat.completions.create({
      model: options?.model || this.defaultModel,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      temperature: options?.temperature ?? 0.8,
      max_tokens: options?.maxTokens,
      stream: false
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from OpenAI');
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
    prompt: string,
    options?: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    try {
      console.log('[OpenAI] Generating image:', {
        model: options?.model || this.defaultImageModel,
        prompt: prompt.substring(0, 100),
        size: options?.size,
        quality: options?.quality
      });

      const response = await this.client.images.generate({
        model: options?.model || this.defaultImageModel,
        prompt,
        n: 1,
        size: (options?.size as '1024x1024' | '1792x1024' | '1024x1792') || '1024x1024',
        quality: (options?.quality as 'auto' | 'high' | 'medium' | 'low') || 'auto'
      });

      // Response received successfully

      if (!response.data || response.data.length === 0) {
        throw new Error('No image data from OpenAI');
      }

      const image = response.data[0];
      if (!image) {
        throw new Error('No image in response');
      }

      // GPT image models return base64-encoded images, not URLs
      if (image.b64_json) {
        return {
          url: `data:image/png;base64,${image.b64_json}`,
          revisedPrompt: image.revised_prompt
        };
      }

      // dall-e models return URLs
      if (!image.url) {
        throw new Error('No image URL from OpenAI');
      }

      return {
        url: image.url,
        revisedPrompt: image.revised_prompt
      };
    } catch (error) {
      console.error('[OpenAI] Image generation failed:', error);
      if (error instanceof Error) {
        throw new Error(`OpenAI image generation failed: ${error.message}`);
      }
      throw error;
    }
  }

  async analyzeImage(
    imageUrl: string,
    prompt: string,
    options?: ImageAnalysisOptions
  ): Promise<ImageAnalysisResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    // Use gpt-5-mini for vision tasks as well
    const response = await this.client.chat.completions.create({
      model: options?.model || this.defaultModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      max_tokens: options?.maxTokens || 500
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from OpenAI vision');
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
