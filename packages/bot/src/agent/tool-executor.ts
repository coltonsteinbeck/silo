import { calculateVideoQuotaCost } from '../services/media-quota';
import type { GuildMember } from 'discord.js';
import type { QuotaMiddleware } from '../middleware/quota';
import {
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
  referenceImages?: string[];
  signal?: AbortSignal;
  quota?: {
    middleware: Pick<QuotaMiddleware, 'executeReserved'>;
    operationKey: string;
    guildId: string;
    userId: string;
    member: GuildMember | null;
    referenceImageCount: number;
  };
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

export function createProviderToolExecutor(context: AgentToolExecutionContext): AgentToolExecutor {
  const execute: AgentToolExecutor = async request => {
    try {
      context.signal?.throwIfAborted();
      if (request.name === 'web_search') {
        return {
          name: request.name,
          status: 'unsupported',
          message: 'Web search requires an explicit search command.'
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
          inputFidelity: action === 'edit' ? 'high' : 'low',
          signal: context.signal
        });
        context.signal?.throwIfAborted();

        if (result.moderationPassed === false) {
          return {
            name: 'image_generation',
            status: 'error',
            message: 'Media generation was blocked by safety checks.'
          };
        }

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
          context.registry.getConfiguredVideoModel(provider.name);
        const result = await provider.generateVideo(prompt, {
          model: model || undefined,
          duration: numberInput(request.input?.duration, 8),
          resolution: '480p',
          referenceImages: context.referenceImages || [],
          signal: context.signal
        });
        context.signal?.throwIfAborted();

        if (result.moderationPassed === false) {
          return {
            name: 'video_generation',
            status: 'error',
            message: 'Media generation was blocked by safety checks.'
          };
        }

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

  return async request => {
    context.signal?.throwIfAborted();
    const quota = context.quota;
    if (!quota || (request.name !== 'image_generation' && request.name !== 'video_generation')) {
      return execute(request);
    }
    if (!quota.member) {
      return {
        name: request.name,
        status: 'error',
        message: 'Media generation requires a guild member context for quota checks.'
      };
    }
    let cost: number;
    try {
      cost =
        request.name === 'image_generation'
          ? 1 + quota.referenceImageCount
          : calculateVideoQuotaCost(
              numberInput(request.input?.duration, 8),
              '480p',
              quota.referenceImageCount
            );
    } catch (error) {
      return { name: request.name, status: 'error', message: (error as Error).message };
    }
    const result = await quota.middleware.executeReserved({
      operationKey: `${quota.operationKey}:${request.name}`,
      guildId: quota.guildId,
      userId: quota.userId,
      member: quota.member,
      usageType: request.name === 'image_generation' ? 'images' : 'video_tokens',
      requestedAmount: cost,
      beforeAttempt: () => context.signal?.throwIfAborted(),
      execute: () => execute(request),
      // A returned error may follow billable work; retain the fixed reservation.
      getActualAmount: () => cost
    });
    return result.allowed
      ? result.value
      : { name: request.name, status: 'error', message: result.reason };
  };
}
