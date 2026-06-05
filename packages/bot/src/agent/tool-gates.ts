import type { AgentGraphRuntimeConfig } from './config';
import type { AgentToolRequest } from './types';

export function filterRequestedAgentTools(
  requestedTools: AgentToolRequest[],
  config: Pick<AgentGraphRuntimeConfig, 'searchEnabled' | 'mediaNaturalLanguageEnabled'>
): AgentToolRequest[] {
  return requestedTools.filter(tool => {
    if (tool.name === 'web_search') {
      return config.searchEnabled;
    }

    if (tool.name === 'image_generation' || tool.name === 'video_generation') {
      return config.mediaNaturalLanguageEnabled;
    }

    return true;
  });
}

export function shouldClarifyDisabledMediaIntent({
  originalToolCount,
  enabledToolCount,
  intent
}: {
  originalToolCount: number;
  enabledToolCount: number;
  intent: string | undefined;
}): boolean {
  return (
    enabledToolCount === 0 &&
    originalToolCount > 0 &&
    (intent === 'image_generate' || intent === 'image_edit' || intent === 'video_generate')
  );
}
