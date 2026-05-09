import type {
  TextProvider,
  ImageProvider,
  VideoProvider,
  EmbeddingProvider,
  Config
} from '@silo/core';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { XAIProvider } from './xai';
import { LocalOpenAIProvider } from './local-openai';
import { OpenAIEmbeddingsProvider } from './openai-embeddings';
import { GoogleImageProvider, GoogleTextProvider } from './google';

export class ProviderRegistry {
  private textProviders: TextProvider[] = [];
  private imageProviders: ImageProvider[] = [];
  private videoProviders: VideoProvider[] = [];
  private embeddingProvider: EmbeddingProvider | null = null;

  constructor(config: Config) {
    if (config.providers.openai?.apiKey) {
      const provider = new OpenAIProvider(
        config.providers.openai.apiKey,
        config.providers.openai.model,
        config.providers.openai.imageModel
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
      const provider = new XAIProvider(
        config.providers.xai.apiKey,
        config.providers.xai.model,
        config.providers.xai.imageModel,
        config.providers.xai.videoModel,
        config.providers.xai.baseURL
      );
      this.textProviders.push(provider);
      this.imageProviders.push(provider);
      this.videoProviders.push(provider);
    }

    if (config.providers.google?.apiKey) {
      // Add Google text provider for text generation
      const textProvider = new GoogleTextProvider(
        config.providers.google.apiKey,
        config.providers.google.model
      );
      this.textProviders.push(textProvider);

      // Also add Google image provider for image generation
      const imageProvider = new GoogleImageProvider(
        config.providers.google.apiKey,
        config.providers.google.model
      );
      this.imageProviders.push(imageProvider);
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
      
      // Log that requested provider wasn't found
      const availableText = this.textProviders.filter(p => p.isConfigured()).map(p => p.name);
      console.warn(`[PROVIDER] Requested text provider "${name}" not available. Available: ${availableText.join(', ')}. Falling back to first available.`);
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

  getAvailableProviders(): { text: string[]; image: string[]; video: string[] } {
    return {
      text: this.textProviders.filter(p => p.isConfigured()).map(p => p.name),
      image: this.imageProviders.filter(p => p.isConfigured()).map(p => p.name),
      video: this.videoProviders.filter(p => p.isConfigured()).map(p => p.name)
    };
  }

  getEmbeddingProvider(): EmbeddingProvider {
    if (!this.embeddingProvider || !this.embeddingProvider.isConfigured()) {
      throw new Error('No embedding provider configured. Enable RAG and add OpenAI API key');
    }
    return this.embeddingProvider;
  }

  hasEmbeddingProvider(): boolean {
    return !!this.embeddingProvider && this.embeddingProvider.isConfigured();
  }

  getVisionProvider(name?: string): ImageProvider | null {
    const candidates = name
      ? this.imageProviders.filter(p => p.name === name)
      : this.imageProviders;

    for (const provider of candidates) {
      if (provider.isConfigured() && provider.analyzeImage) {
        return provider;
      }
    }

    return null;
  }

  getVideoProvider(name?: string): VideoProvider | null {
    if (name) {
      const provider = this.videoProviders.find(p => p.name === name);
      if (provider && provider.isConfigured()) {
        return provider;
      }
      return null;
    }

    return this.videoProviders.find(p => p.isConfigured()) || null;
  }
}
