import type { TextProvider, ImageProvider, Config } from '@silo/core';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';

export class ProviderRegistry {
  private textProviders: TextProvider[] = [];
  private imageProviders: ImageProvider[] = [];

  constructor(config: Config) {
    if (config.providers.openai?.apiKey) {
      const provider = new OpenAIProvider(
        config.providers.openai.apiKey,
        config.providers.openai.model
      );
      this.textProviders.push(provider);
      this.imageProviders.push(provider);
    }

    if (config.providers.anthropic?.apiKey) {
      const provider = new AnthropicProvider(
        config.providers.anthropic.apiKey,
        config.providers.anthropic.model
      );
      this.textProviders.push(provider);
    }
  }

  getTextProvider(name?: string): TextProvider {
    if (name) {
      const provider = this.textProviders.find(p => p.name === name);
      if (provider) return provider;
    }

    const configured = this.textProviders.find(p => p.isConfigured());
    if (!configured) {
      throw new Error('No text provider configured. Add API keys to .env');
    }
    return configured;
  }

  getImageProvider(name?: string): ImageProvider {
    if (name) {
      const provider = this.imageProviders.find(p => p.name === name);
      if (provider) return provider;
    }

    const configured = this.imageProviders.find(p => p.isConfigured());
    if (!configured) {
      throw new Error('No image provider configured. Add API keys to .env');
    }
    return configured;
  }

  getAvailableProviders(): { text: string[]; image: string[] } {
    return {
      text: this.textProviders.filter(p => p.isConfigured()).map(p => p.name),
      image: this.imageProviders.filter(p => p.isConfigured()).map(p => p.name)
    };
  }
}
