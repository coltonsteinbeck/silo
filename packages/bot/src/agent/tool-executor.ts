import type {
  ImageGenerationResponse,
  TextGenerationResponse,
  VideoGenerationResponse,
  WebSearchResponse
} from '@silo/core';
import { ProviderRegistry } from '../providers/registry';
import { sanitizeDiscordMassMentions } from '../security/output-sanitizer';
import type { AgentToolRequest, AgentToolResult } from './types';

export interface AgentMediaResult {
  kind: 'image' | 'video';
  url: string;
  model?: string;
  prompt: string;
  revisedPrompt?: string;
  moderationPassed?: boolean;
}

export interface AgentToolExecutionContext {
  registry: ProviderRegistry;
  preferredProviderName: string;
  searchFallbackProviderName?: string;
  textModel?: string;
  referenceImages?: string[];
}

export type AgentToolExecutor = (request: AgentToolRequest) => Promise<AgentToolExecutionResult>;

export type AgentToolExecutionResult =
  | (AgentToolResult & { status: 'skipped' | 'unsupported' | 'budget_exceeded' | 'error' })
  | {
      name: 'web_search';
      status: 'success';
      message: string;
      content: string;
      citations: WebSearchResponse['citations'];
      model?: string;
      usage?: TextGenerationResponse['usage'];
      query: string;
      provider?: string;
    }
  | {
      name: 'image_generation';
      status: 'success';
      message: string;
      media: AgentMediaResult;
      raw: ImageGenerationResponse;
    }
  | {
      name: 'video_generation';
      status: 'success';
      message: string;
      media: AgentMediaResult;
      raw: VideoGenerationResponse;
    };

function stringInput(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberInput(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isConfiguredSearchProvider(
  provider: ReturnType<ProviderRegistry['getWebSearchProvider']>
): provider is NonNullable<ReturnType<ProviderRegistry['getWebSearchProvider']>> {
  return Boolean(provider);
}

function shouldPreferXaiSearch(query: string): boolean {
  const lower = query.toLowerCase();
  const asksForLiveResult =
    /\b(who(?:'s| is) winning|winner|score|scores|live|right now|rn|current|standings|series)\b/i.test(
      lower
    );
  const sportsTopic =
    /\b(nba|nfl|mlb|nhl|wnba|ufc|finals?|playoffs?|game|match|team|season)\b/i.test(lower);

  return asksForLiveResult && sportsTopic;
}

export function createProviderToolExecutor(context: AgentToolExecutionContext): AgentToolExecutor {
  return async request => {
    try {
      if (request.name === 'web_search') {
        const query = stringInput(request.input?.query, '');
        if (!query) {
          return {
            name: request.name,
            status: 'error',
            message: 'Web search requires a non-empty query.'
          };
        }

        const providers = [
          ...(shouldPreferXaiSearch(query) ? [context.registry.getWebSearchProvider('xai')] : []),
          context.registry.getWebSearchProvider(context.preferredProviderName),
          context.registry.getWebSearchProvider(context.searchFallbackProviderName),
          context.registry.getWebSearchProvider()
        ]
          .filter(isConfiguredSearchProvider)
          .filter(
            (provider, index, candidates) =>
              candidates.findIndex(candidate => candidate.name === provider.name) === index
          );

        if (providers.length === 0) {
          return {
            name: request.name,
            status: 'unsupported',
            message: `Tool ${request.name} is not supported by the selected provider/model.`
          };
        }

        const failedProviders: string[] = [];
        for (const provider of providers) {
          try {
            const result = await provider.searchWeb(query, {
              model:
                provider.name === context.preferredProviderName
                  ? context.textModel
                  : context.registry.getConfiguredTextModel(provider.name),
              maxResults: numberInput(request.input?.maxResults, 5)
            });

            return {
              name: 'web_search',
              status: 'success',
              message:
                failedProviders.length > 0
                  ? `Web search completed with ${provider.name} after fallback.`
                  : 'Web search completed.',
              content: result.content,
              citations: result.citations,
              provider: provider.name,
              model: result.model,
              usage: result.usage,
              query
            };
          } catch {
            failedProviders.push(provider.name);
          }
        }

        return {
          name: 'web_search',
          status: 'error',
          message: `Web search failed for configured providers: ${failedProviders.join(', ')}.`
        };
      }

      if (request.name === 'image_generation') {
        const provider =
          context.registry.getImageProvider(context.preferredProviderName) ||
          context.registry.getImageProvider();
        const prompt = sanitizeDiscordMassMentions(stringInput(request.input?.prompt, ''));
        if (!prompt) {
          return {
            name: request.name,
            status: 'error',
            message: 'Image generation requires a non-empty prompt.'
          };
        }

        const action =
          request.input?.action === 'edit' || (context.referenceImages || []).length > 0
            ? 'edit'
            : 'generate';
        const model =
          stringInput(request.input?.model, '') ||
          context.registry.getConfiguredImageModel(provider.name);
        const result = await provider.generateImage(prompt, {
          model: model || undefined,
          referenceImages: context.referenceImages || [],
          action,
          inputFidelity: action === 'edit' ? 'high' : 'low'
        });

        return {
          name: 'image_generation',
          status: 'success',
          message: 'Image generation completed.',
          media: {
            kind: 'image',
            url: result.url,
            model: result.model || model,
            prompt,
            revisedPrompt: result.revisedPrompt,
            moderationPassed: result.moderationPassed
          },
          raw: result
        };
      }

      if (request.name === 'video_generation') {
        const preferredVideoProvider = stringInput(
          request.input?.provider,
          context.preferredProviderName
        );
        const provider =
          context.registry.getVideoProvider(preferredVideoProvider) ||
          context.registry.getVideoProvider();
        if (!provider) {
          return {
            name: request.name,
            status: 'unsupported',
            message: `Tool ${request.name} is not supported by the selected provider/model.`
          };
        }

        const prompt = sanitizeDiscordMassMentions(stringInput(request.input?.prompt, ''));
        if (!prompt) {
          return {
            name: request.name,
            status: 'error',
            message: 'Video generation requires a non-empty prompt.'
          };
        }

        const model =
          stringInput(request.input?.model, '') ||
          context.registry.getConfiguredVideoModel(provider.name) ||
          'grok-imagine-video';
        const result = await provider.generateVideo(prompt, {
          model,
          duration: numberInput(request.input?.duration, 8),
          referenceImages: context.referenceImages || []
        });

        return {
          name: 'video_generation',
          status: 'success',
          message: 'Video generation completed.',
          media: {
            kind: 'video',
            url: result.url,
            model: result.model || model,
            prompt,
            moderationPassed: result.moderationPassed
          },
          raw: result
        };
      }

      return {
        name: request.name,
        status: 'unsupported',
        message: `Tool ${request.name} is not supported by the selected provider/model.`
      };
    } catch (error) {
      return {
        name: request.name,
        status: 'error',
        message: error instanceof Error ? error.message : 'Tool execution failed.'
      };
    }
  };
}
