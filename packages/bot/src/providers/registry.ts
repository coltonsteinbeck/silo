import type { TextProvider, ImageProvider, EmbeddingProvider, Config } from '@silo/core';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { XAIProvider } from './xai';
import { LocalOpenAIProvider } from './local-openai';
import { OpenAIEmbeddingsProvider } from './openai-embeddings';

export class ProviderRegistry {
  private textProviders: TextProvider[] = [];
  private imageProviders: ImageProvider[] = [];
  private embeddingProvider: EmbeddingProvider | null = null;

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

    if (config.providers.xai?.apiKey) {
      const provider = new XAIProvider(config.providers.xai.apiKey, config.providers.xai.model);
      this.textProviders.push(provider);
    }

    if (config.features.enableLocalModels && config.providers.local?.baseURL) {
      const provider = new LocalOpenAIProvider(
        config.providers.local.apiKey,
        config.providers.local.model,
        config.providers.local.baseURL
      );
      this.textProviders.push(provider);
    }

    // Initialize embeddings provider if OpenAI is configured and RAG is enabled
    if (config.features.enableRAG && config.providers.openai?.apiKey) {
      this.embeddingProvider = new OpenAIEmbeddingsProvider(config.providers.openai.apiKey);
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

  getEmbeddingProvider(): EmbeddingProvider {
    if (!this.embeddingProvider || !this.embeddingProvider.isConfigured()) {
      throw new Error('No embedding provider configured. Enable RAG and add OpenAI API key');
    }
    return this.embeddingProvider;
  }
}
