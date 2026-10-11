import type {
  TextProvider,
  TextGenerationOptions,
  ImageProvider,
  VideoProvider,
  WebSearchProvider,
  EmbeddingProvider,
  Config
} from '@silo/core';
import type { QuotaMiddleware, QuotaReservationRequest } from '../middleware/quota';
import { OpenAIProvider } from './openai';
import { XAIProvider } from './xai';
import { withLangfuseSpan } from '../telemetry/langfuse-client';
import { OpenAIEmbeddingsProvider } from './openai-embeddings';

export class ProviderRegistry {
  private textProviders: TextProvider[] = [];
  private imageProviders: ImageProvider[] = [];
  private videoProviders: VideoProvider[] = [];
  private webSearchProviders: WebSearchProvider[] = [];
  private embeddingProvider: EmbeddingProvider | null = null;

  constructor(private readonly config: Config) {
    if (config.providers.openai?.apiKey) {
      const provider = new OpenAIProvider(
        config.providers.openai.apiKey,
        config.providers.openai.model,
        config.providers.openai.imageModel
      );
      this.textProviders.push(provider);
      this.imageProviders.push(provider);
      this.webSearchProviders.push(provider);
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
      this.webSearchProviders.push(provider);
    }

    // Fail at startup instead of silently substituting a configured workload.
    for (const route of Object.values(config.textRouting || {})) {
      if (route) this.getTextProvider(route.provider);
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

      throw new Error(`No text provider configured for requested provider: ${name}`);
    }

    const configured = this.textProviders.find(p => p.isConfigured());
    if (!configured) {
      throw new Error('No text provider configured. Add API keys to .env');
    }
    return configured;
  }

  getTextRoute(
    workload: 'routine' | 'analysis' | 'complex' | 'summary' | 'extraction',
    persona?: { textProvider?: string; textModel?: string },
    quota?: Omit<QuotaReservationRequest, 'requestedAmount' | 'minimumAmount'> & {
      middleware: QuotaMiddleware;
    }
  ): { provider: TextProvider; options: TextGenerationOptions } {
    const roles = this.config.textRouting;
    const usePersona = Boolean(persona?.textProvider) && workload !== 'complex';
    const route = usePersona ? roles?.persona : roles?.[workload];
    const provider = this.getTextProvider(route?.provider || persona?.textProvider);
    const options: TextGenerationOptions = {
      model: route?.model || persona?.textModel || this.getConfiguredTextModel(provider.name),
      ...(route?.maxTokens ? { maxTokens: route.maxTokens } : {}),
      ...(route?.effort ? { reasoning: { effort: route.effort } } : {})
    };
    const fallbackRoute =
      workload === 'routine' || workload === 'analysis'
        ? usePersona
          ? roles?.routine
          : roles?.fallback
        : undefined;
    const fallback =
      fallbackRoute && fallbackRoute.provider !== provider.name
        ? this.getTextProvider(fallbackRoute.provider)
        : undefined;
    let generationIndex = 0;
    return {
      options,
      provider: {
        name: provider.name,
        capabilities: provider.capabilities,
        isConfigured: () => provider.isConfigured(),
        generateText: async (messages, supplied = {}) => {
          const request = {
            ...options,
            ...supplied,
            signal: AbortSignal.any([
              AbortSignal.timeout(60_000),
              ...(supplied.signal ? [supplied.signal] : [])
            ])
          };
          const generationSequence = ++generationIndex;
          const attempt = async (
            target: TextProvider,
            params: TextGenerationOptions,
            index: number
          ) => {
            params.signal?.throwIfAborted();
            return withLangfuseSpan(
              {
                name: 'text.provider-attempt',
                metadata: {
                  provider: target.name,
                  requestedModel: params.model,
                  workload,
                  attempt: index,
                  usageKnown: false
                }
              },
              async generation => {
                const reservedAmount = params.maxTokens || 400;
                const reserved = quota
                  ? await quota.middleware.executeReserved({
                      ...quota,
                      operationKey: `${quota.operationKey}:${generationSequence}:${index}`,
                      requestedAmount: reservedAmount,
                      beforeAttempt: () => params.signal?.throwIfAborted(),
                      execute: () =>
                        target.generateText(messages, { ...params, maxTokens: reservedAmount }),
                      getActualAmount: value => value.usage?.completionTokens ?? reservedAmount
                    })
                  : undefined;
                if (reserved && !reserved.allowed) throw new Error('Text quota reservation denied');
                const response = reserved?.allowed
                  ? reserved.value
                  : await target.generateText(messages, params);
                params.signal?.throwIfAborted();
                generation?.update({
                  metadata: {
                    provider: target.name,
                    requestedModel: params.model,
                    returnedModel: response.model,
                    workload,
                    attempt: index,
                    usageKnown: Boolean(response.usage)
                  }
                });
                return response;
              }
            );
          };
          try {
            return await attempt(provider, request, 1);
          } catch (error) {
            if (
              !quota ||
              !fallback ||
              !fallbackRoute ||
              request.signal?.aborted ||
              !isTransientTextError(error)
            )
              throw error;
            return attempt(
              fallback,
              {
                ...request,
                model: fallbackRoute.model,
                maxTokens: Math.min(request.maxTokens || 400, fallbackRoute.maxTokens || 400),
                reasoning: fallbackRoute.effort ? { effort: fallbackRoute.effort } : undefined
              },
              2
            );
          }
        }
      }
    };
  }

  getConfiguredTextModel(name: string): string | undefined {
    switch (name) {
      case 'openai':
        return this.config.providers.openai?.model;
      case 'xai':
        return this.config.providers.xai?.model;
      default:
        return undefined;
    }
  }

  getConfiguredImageModel(name: string): string | undefined {
    switch (name) {
      case 'openai':
        return this.config.providers.openai?.imageModel;
      case 'xai':
        return this.config.providers.xai?.imageModel;
      default:
        return undefined;
    }
  }

  getConfiguredVideoModel(name: string): string | undefined {
    switch (name) {
      case 'xai':
        return this.config.providers.xai?.videoModel;
      default:
        return undefined;
    }
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

  getAvailableProviders(): {
    text: string[];
    image: string[];
    video: string[];
    webSearch: string[];
  } {
    return {
      text: this.textProviders.filter(p => p.isConfigured()).map(p => p.name),
      image: this.imageProviders.filter(p => p.isConfigured()).map(p => p.name),
      video: this.videoProviders.filter(p => p.isConfigured()).map(p => p.name),
      webSearch: this.webSearchProviders.filter(p => p.isConfigured()).map(p => p.name)
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

  getWebSearchProvider(name?: string): WebSearchProvider | null {
    if (name) {
      const provider = this.webSearchProviders.find(p => p.name === name);
      if (provider && provider.isConfigured()) {
        return provider;
      }
      return null;
    }

    return this.webSearchProviders.find(p => p.isConfigured()) || null;
  }
}

export function classifyTextWorkload(text: string): 'routine' | 'analysis' | 'complex' {
  if (
    /\b(long[- ]form|deep dive|detailed discussion|comprehensive|thorough|essay|walk me through|prove|architecture|multi[- ]step)\b/i.test(
      text
    ) ||
    /^(?:please\s+)?(?:draft|write|compose)\b.{0,80}\b(?:proposal|report)\b/i.test(text.trim())
  )
    return 'complex';
  if (/\b(analy[sz]e|compare|evaluate|explain why|trade[- ]offs|debug|calculate)\b/i.test(text))
    return 'analysis';
  return 'routine';
}

function isTransientTextError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = error as Error & { status?: number; refused?: boolean };
  return (
    !detail.refused &&
    (detail.status === 408 ||
      detail.status === 429 ||
      (typeof detail.status === 'number' && detail.status >= 500 && detail.status <= 599) ||
      ['APIConnectionError', 'APIConnectionTimeoutError', 'TimeoutError'].includes(error.name))
  );
}
