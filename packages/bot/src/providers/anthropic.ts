import Anthropic from '@anthropic-ai/sdk';
import type { TextProvider, Message, TextGenerationOptions, TextGenerationResponse } from '@silo/core';

export class AnthropicProvider implements TextProvider {
  name = 'anthropic';
  private client: Anthropic | null = null;
  private apiKey?: string;
  private defaultModel: string;

  constructor(apiKey?: string, model: string = 'claude-3-5-sonnet-20241022') {
    this.apiKey = apiKey;
    this.defaultModel = model;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async generateText(messages: Message[], options?: TextGenerationOptions): Promise<TextGenerationResponse> {
    if (!this.client) {
      throw new Error('Anthropic provider not configured');
    }

    const systemMessage = messages.find(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const response = await this.client.messages.create({
      model: options?.model || this.defaultModel,
      system: systemMessage?.content,
      messages: conversationMessages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      })),
      temperature: options?.temperature ?? 0.8,
      max_tokens: options?.maxTokens || 2048
    });

    const textContent = response.content.find(c => c.type === 'text');
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text response from Anthropic');
    }

    return {
      content: textContent.text,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens
      },
      model: response.model
    };
  }
}
