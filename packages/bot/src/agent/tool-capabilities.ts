import type { ProviderCapabilities } from '@silo/core';
import type { ProviderRegistry } from '../providers/registry';
import type { AgentProviderCapabilities } from './types';

export interface ToolCapabilityMatrix {
  providerName: string;
  model?: string;
  capabilities?: ProviderCapabilities;
  supportsText: boolean;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  webSearchProviderName?: string;
  supportsImageGeneration: boolean;
  supportsVideoGeneration: boolean;
}

export function resolveToolCapabilities(params: {
  registry: ProviderRegistry;
  providerName: string;
  model?: string;
  capabilities?: ProviderCapabilities;
  webSearchEnabled: boolean;
}): ToolCapabilityMatrix {
  const available = params.registry.getAvailableProviders();
  const webSearchProviderName = available.webSearch.includes(params.providerName)
    ? params.providerName
    : available.webSearch[0];
  const supportsWebSearch = params.webSearchEnabled && Boolean(webSearchProviderName);

  return {
    providerName: params.providerName,
    model: params.model,
    capabilities: params.capabilities,
    supportsText: available.text.includes(params.providerName),
    supportsVision: Boolean(params.capabilities?.vision),
    supportsWebSearch,
    webSearchProviderName: supportsWebSearch ? webSearchProviderName : undefined,
    supportsImageGeneration: available.image.includes(params.providerName),
    supportsVideoGeneration:
      available.video.includes(params.providerName) || Boolean(params.capabilities?.videoGeneration)
  };
}

export function toAgentProviderCapabilities(
  matrix: ToolCapabilityMatrix
): AgentProviderCapabilities {
  return {
    providerName: matrix.providerName,
    model: matrix.model,
    capabilities: matrix.capabilities,
    hasImageProvider: matrix.supportsImageGeneration,
    hasVideoProvider: matrix.supportsVideoGeneration,
    hasWebSearch: matrix.supportsWebSearch
  };
}
