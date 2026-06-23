import type { AgentGraphLimits } from './config';
import type { AgentToolExecutionResult, AgentToolExecutor } from './tool-executor';
import type {
  AgentProviderCapabilities,
  AgentToolName,
  AgentToolRequest,
  AgentToolResult
} from './types';

export function resolveAllowedAgentTools(provider: AgentProviderCapabilities): AgentToolName[] {
  const allowed = new Set<AgentToolName>();

  if (provider.hasWebSearch) {
    allowed.add('web_search');
  }

  if (provider.hasImageProvider) {
    allowed.add('image_generation');
  }

  if (provider.hasVideoProvider || provider.capabilities?.videoGeneration) {
    allowed.add('video_generation');
  }

  if (provider.capabilities?.vision) {
    allowed.add('vision_analysis');
  }

  return Array.from(allowed);
}

export function executeBoundedToolPlan(params: {
  requestedTools: AgentToolRequest[];
  toolsAllowed: AgentToolName[];
  limits: AgentGraphLimits;
  executor?: AgentToolExecutor;
}): Promise<{ toolsCalled: AgentToolName[]; toolResults: AgentToolResult[] }> {
  return executeBoundedToolPlanAsync(params);
}

function toAgentToolResult(result: AgentToolExecutionResult): AgentToolResult {
  return {
    name: result.name,
    status: result.status,
    message: result.message,
    content: 'content' in result ? result.content : undefined,
    citations: 'citations' in result ? result.citations : undefined,
    query: 'query' in result ? result.query : undefined,
    provider: 'provider' in result ? result.provider : undefined,
    model: 'model' in result ? result.model : undefined,
    media: 'media' in result ? result.media : undefined
  };
}

async function executeBoundedToolPlanAsync(params: {
  requestedTools: AgentToolRequest[];
  toolsAllowed: AgentToolName[];
  limits: AgentGraphLimits;
  executor?: AgentToolExecutor;
}): Promise<{ toolsCalled: AgentToolName[]; toolResults: AgentToolResult[] }> {
  const toolsAllowed = new Set(params.toolsAllowed);
  const toolsCalled: AgentToolName[] = [];
  const toolResults: AgentToolResult[] = [];
  let webSearches = 0;
  let imageGenerations = 0;
  let videoGenerations = 0;

  for (const request of params.requestedTools.slice(0, params.limits.maxToolCalls)) {
    if (!toolsAllowed.has(request.name)) {
      toolResults.push({
        name: request.name,
        status: 'unsupported',
        message: `Tool ${request.name} is not supported by the selected provider/model.`
      });
      continue;
    }

    if (request.name === 'web_search') {
      webSearches += 1;
      if (webSearches > params.limits.maxWebSearches) {
        toolResults.push({
          name: request.name,
          status: 'budget_exceeded',
          message: 'Web search budget exceeded for this turn.'
        });
        continue;
      }
    }

    if (request.name === 'image_generation') {
      imageGenerations += 1;
      if (imageGenerations > params.limits.maxImageGenerations) {
        toolResults.push({
          name: request.name,
          status: 'budget_exceeded',
          message: 'Image generation budget exceeded for this turn.'
        });
        continue;
      }
    }

    if (request.name === 'video_generation') {
      videoGenerations += 1;
      if (videoGenerations > params.limits.maxVideoGenerations) {
        toolResults.push({
          name: request.name,
          status: 'budget_exceeded',
          message: 'Video generation budget exceeded for this turn.'
        });
        continue;
      }
    }

    if (!params.executor) {
      toolsCalled.push(request.name);
      toolResults.push({
        name: request.name,
        status: 'skipped',
        message:
          'Tool execution is enabled only when a graph tool executor is configured for this turn.'
      });
      continue;
    }

    const executionResult = toAgentToolResult(await params.executor(request));
    if (executionResult.status === 'success') {
      toolsCalled.push(request.name);
    }
    toolResults.push(executionResult);
  }

  if (params.requestedTools.length > params.limits.maxToolCalls) {
    for (const request of params.requestedTools.slice(params.limits.maxToolCalls)) {
      toolResults.push({
        name: request.name,
        status: 'budget_exceeded',
        message: 'Tool call budget exceeded for this turn.'
      });
    }
  }

  return { toolsCalled, toolResults };
}
