/**
 * Local OpenAI-compatible provider (e.g., Ollama, LM Studio)
 */
import OpenAI from 'openai';
import type {
  TextProvider,
  Message,
  TextGenerationOptions,
  TextGenerationResponse
} from '@silo/core';

export class LocalOpenAIProvider implements TextProvider {
  name = 'local';
  protected client: OpenAI | null = null;
  private defaultModel: string;

  constructor(
    apiKey: string | undefined,
    model = 'llama3.1',
    baseURL = 'http://localhost:11434/v1'
  ) {
    this.defaultModel = model;
    // Local providers are always configured if a baseURL is provided
    // Some local endpoints ignore API keys; provide a placeholder if missing.
    this.client = new OpenAI({ apiKey: apiKey || 'local', baseURL });
  }

  isConfigured(): boolean {
    // Local provider is always configured once instantiated
    return true;
  }

  async generateText(
    messages: Message[],
    options?: TextGenerationOptions
  ): Promise<TextGenerationResponse> {
    const response = await this.client!.chat.completions.create({
      model: options?.model || this.defaultModel,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.8,
      max_tokens: options?.maxTokens,
      stream: false
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from local provider');
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
