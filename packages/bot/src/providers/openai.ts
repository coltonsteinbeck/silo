import OpenAI from 'openai';
import type { TextProvider, ImageProvider, Message, TextGenerationOptions, TextGenerationResponse, ImageGenerationOptions, ImageGenerationResponse, ImageAnalysisOptions, ImageAnalysisResponse } from '@silo/core';

export class OpenAIProvider implements TextProvider, ImageProvider {
  name = 'openai';
  private client: OpenAI | null = null;
  private apiKey?: string;
  private defaultModel: string;

  constructor(apiKey?: string, model: string = 'gpt-4o-mini') {
    this.apiKey = apiKey;
    this.defaultModel = model;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async generateText(messages: Message[], options?: TextGenerationOptions): Promise<TextGenerationResponse> {
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
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined,
      model: response.model
    };
  }

  async generateImage(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    const response = await this.client.images.generate({
      model: options?.model || 'dall-e-3',
      prompt,
      n: 1,
      size: (options?.size as '1024x1024' | '1792x1024' | '1024x1792') || '1024x1024',
      quality: (options?.quality as 'standard' | 'hd') || 'standard'
    });

    const image = response.data[0];
    if (!image?.url) {
      throw new Error('No image URL from OpenAI');
    }

    return {
      url: image.url,
      revisedPrompt: image.revised_prompt
    };
  }

  async analyzeImage(imageUrl: string, prompt: string, options?: ImageAnalysisOptions): Promise<ImageAnalysisResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    const response = await this.client.chat.completions.create({
      model: options?.model || 'gpt-4o-mini',
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
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens
      } : undefined
    };
  }
}
