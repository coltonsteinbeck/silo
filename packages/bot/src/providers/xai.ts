import OpenAI from 'openai';
import type {
  TextProvider,
  Message,
  TextGenerationOptions,
  TextGenerationResponse
} from '@silo/core';

/**
 * xAI/Grok provider using OpenAI-compatible API
 * https://docs.x.ai/api
 */
export class XAIProvider implements TextProvider {
  name = 'xai';
  private client: OpenAI | null = null;
  private defaultModel: string;

  constructor(apiKey?: string, model: string = 'grok-3-mini') {
    this.defaultModel = model;
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: 'https://api.x.ai/v1'
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
      max_tokens: options?.maxTokens,
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
}
