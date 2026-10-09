import OpenAI, { toFile } from 'openai';
import { downloadMedia } from '../services/media-download';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import {
  logger,
  type TextProvider,
  type ImageProvider,
  type Message,
  type TextGenerationOptions,
  type TextGenerationResponse,
  type ImageGenerationOptions,
  type ImageGenerationResponse,
  type ImageAnalysisOptions,
  type ImageAnalysisResponse,
  type WebSearchOptions,
  type WebSearchProvider,
  type WebSearchResponse
} from '@silo/core';
import { normalizeTextGenerationFinishReason } from './finish-reason';

interface OpenAIWebSearchAnnotation {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface OpenAIWebSearchContentItem {
  type?: string;
  text?: string;
  annotations?: OpenAIWebSearchAnnotation[];
}

interface OpenAIWebSearchOutputItem {
  type?: string;
  phase?: string | null;
  content?: OpenAIWebSearchContentItem[];
}

interface OpenAIWebSearchResult {
  output_text?: string;
  output?: OpenAIWebSearchOutputItem[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

// The SDK convenience text concatenates commentary and final messages.
function answerMessages(response: OpenAIWebSearchResult): OpenAIWebSearchOutputItem[] {
  const messages = (response.output || []).filter(item => item.type === 'message' || !item.type);
  return messages.some(item => item.phase === 'final_answer')
    ? messages.filter(item => item.phase === 'final_answer')
    : messages.filter(item => item.phase !== 'commentary');
}

function answerText(response: OpenAIWebSearchResult): string {
  const text = answerMessages(response)
    .flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text' || !item.type)
    .map(item => item.text || '')
    .join('');
  return response.output?.some(item => item.phase) ? text : response.output_text || text;
}

type OpenAIImageSize = '256x256' | '512x512' | '1024x1024' | '1024x1536' | '1536x1024' | 'auto';

export function toOpenAIImageSize(size: string | undefined): OpenAIImageSize {
  switch (size) {
    case '256x256':
    case '512x512':
    case '1024x1024':
    case '1024x1536':
    case '1536x1024':
    case 'auto':
      return size;
    default:
      return '1024x1024';
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted-key]')
    .replace(/\bxai-[A-Za-z0-9_-]+\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9_.-]+\b/gi, 'Bearer [redacted-token]');
}

type OpenAIReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

const MAX_OPENAI_OUTPUT_TOKENS = 16000;

function toReasoningEffort(
  reasoning: TextGenerationOptions['reasoning']
): OpenAIReasoningEffort | null {
  if (!reasoning) {
    return null;
  }

  if (reasoning.effort) return reasoning.effort;

  if (reasoning.type === 'enabled') {
    return 'medium';
  }

  if (reasoning.type === 'budgeted') {
    const budget = typeof reasoning.budget === 'number' ? reasoning.budget : 0;
    if (budget <= 2000) return 'low';
    if (budget <= 6000) return 'medium';
    if (budget <= 12000) return 'high';
    return 'xhigh';
  }

  return null;
}

function clampOutputTokens(value: number): number {
  return Math.min(Math.max(1, Math.trunc(value)), MAX_OPENAI_OUTPUT_TOKENS);
}

export class OpenAIProvider implements TextProvider, ImageProvider, WebSearchProvider {
  name = 'openai';
  capabilities = { vision: true, maxImagesPerRequest: 1, maxImageReferences: 5 };
  private client: OpenAI | null = null;
  private defaultModel: string;
  private defaultImageModel: string;

  constructor(apiKey?: string, model: string = 'gpt-6-luna', imageModel: string = 'gpt-image-1') {
    this.defaultModel = model;
    this.defaultImageModel = imageModel;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  isConfigured(): boolean {
    return !!this.client;
  }

  async generateText(
    messages: Message[],
    options?: TextGenerationOptions
  ): Promise<TextGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    const effort = toReasoningEffort(options?.reasoning);
    const request: ResponseCreateParamsNonStreaming = {
      model: options?.model || this.defaultModel,
      input: messages.map(({ role, content }) => ({ role, content })),
      store: false,
      stream: false,
      ...(effort ? { reasoning: { effort } } : {}),
      // Reasoning models reject sampling controls unless reasoning is disabled.
      ...(effort === 'none' && options?.temperature !== undefined
        ? { temperature: options.temperature }
        : {})
    };
    let maxOutputTokens =
      typeof options?.maxTokens === 'number' ? clampOutputTokens(options.maxTokens) : undefined;
    if (options?.reasoning?.type === 'budgeted' && typeof options.reasoning.budget === 'number') {
      const budgetCap = clampOutputTokens(options.reasoning.budget);
      maxOutputTokens =
        maxOutputTokens === undefined ? budgetCap : Math.min(maxOutputTokens, budgetCap);
    }
    if (maxOutputTokens !== undefined) request.max_output_tokens = maxOutputTokens;

    const response = await this.client.responses.create(request, {
      signal: options?.signal,
      maxRetries: 0
    });
    if (response.status !== 'completed' && response.status !== 'incomplete') {
      throw new Error('OpenAI text generation did not complete');
    }
    const refusals = response.output.flatMap(item =>
      item.type === 'message'
        ? item.content.flatMap(part => (part.type === 'refusal' ? [part.refusal] : []))
        : []
    );
    const content = refusals.length ? refusals.join('\n') : answerText(response);
    if (!content?.trim()) throw new Error('No response from OpenAI');
    const providerFinishReason = refusals.length
      ? 'refusal'
      : response.incomplete_details?.reason ||
        (response.status === 'completed' ? 'stop' : 'incomplete');
    return {
      content,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
            reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens,
            cacheReadTokens: response.usage.input_tokens_details?.cached_tokens
          }
        : undefined,
      model: response.model,
      finishReason: normalizeTextGenerationFinishReason(providerFinishReason),
      providerFinishReason
    };
  }

  async generateImage(
    prompt: string,
    options?: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    try {
      const references = options?.referenceImages || [];

      if (references.length > this.capabilities.maxImageReferences)
        throw new Error('Too many reference images');
      const params = {
        model: options?.model || this.defaultImageModel,
        prompt,
        n: 1,
        size: toOpenAIImageSize(options?.size),
        quality: (options?.quality as 'auto' | 'high' | 'medium' | 'low') || 'auto'
      };
      const signal = AbortSignal.any([
        AbortSignal.timeout(180_000),
        ...(options?.signal ? [options.signal] : [])
      ]);
      const requestOptions = { signal, maxRetries: 0 };
      const images = [];
      for (const reference of references) {
        const media = await downloadMedia(reference, { maxBytes: 20 * 1024 * 1024, signal });
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(media.contentType))
          throw new Error('Unsupported reference image');
        images.push(
          await toFile(media.bytes, 'reference.' + media.contentType.split('/')[1], {
            type: media.contentType
          })
        );
      }
      const response = references.length
        ? await this.client.images.edit(
            {
              ...params,
              image: images,
              ...(['gpt-image-1', 'gpt-image-1.5'].includes(params.model) && options?.inputFidelity
                ? { input_fidelity: options.inputFidelity }
                : {})
            },
            requestOptions
          )
        : await this.client.images.generate(params, requestOptions);

      // Response received successfully

      if (!response.data || response.data.length === 0) {
        throw new Error('No image data from OpenAI');
      }

      const image = response.data[0];
      if (!image) {
        throw new Error('No image in response');
      }

      // GPT image models return base64-encoded images, not URLs
      if (image.b64_json) {
        return {
          url: `data:image/png;base64,${image.b64_json}`,
          revisedPrompt: image.revised_prompt,
          model: options?.model || this.defaultImageModel
        };
      }

      // dall-e models return URLs
      if (!image.url) {
        throw new Error('No image URL from OpenAI');
      }

      return {
        url: image.url,
        revisedPrompt: image.revised_prompt,
        model: options?.model || this.defaultImageModel
      };
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      logger.error('[OpenAI] Image generation failed:', message);
      throw new Error(`OpenAI image generation failed: ${message}`, { cause: error });
    }
  }

  async searchWeb(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
    options?.signal?.throwIfAborted();
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    const model = options?.model || this.defaultModel;
    let response: OpenAIWebSearchResult;

    try {
      response = (await this.client.responses.create(
        {
          model,
          input: query,
          instructions:
            `Current UTC date: ${new Date().toISOString().slice(0, 10)}. ` +
            'Resolve relative dates against this date unless the user specifies a timezone or date. ' +
            'Never call a different calendar date today; distinguish the next event from an event today. ' +
            'Use ordinary web search queries to find relevant webpages, preferring primary sources. ' +
            'Do not use structured sports, weather, or finance feeds. ' +
            'Answer concisely from retrieved webpages with inline URL citations. ' +
            'Cite the exact page that directly supports each claim, not a homepage or an unrelated search result. ' +
            'When release notes are requested, retrieve and cite the version-specific official release notes. ' +
            'Never attach an unrelated citation just to provide a source; unsupported or fictional events have no verified winner. ' +
            'For schedules, match the requested sport and competition; an empty or unsupported feed is not evidence that no event exists. ' +
            'If sources cannot establish the answer, say so without guessing.',
          tools: [{ type: 'web_search' }],
          tool_choice: 'required',
          max_tool_calls: 2,
          max_output_tokens: 1200,
          store: false
        } as any,
        { signal: options?.signal, maxRetries: 0, timeout: 20_000 }
      )) as OpenAIWebSearchResult;
    } catch (error) {
      logger.error('[OpenAI] Web search failed', {
        model,
        errorType: error instanceof Error ? error.name : typeof error
      });
      throw error;
    }

    const outputText = answerText(response).trim();

    const citations = answerMessages(response)
      .flatMap(item => item.content || [])
      .flatMap(item => item.annotations || [])
      .filter(annotation => annotation.type === 'url_citation' && annotation.url)
      .slice(0, options?.maxResults || 5)
      .map(annotation => ({
        url: annotation.url as string,
        title: annotation.title,
        startIndex: annotation.start_index,
        endIndex: annotation.end_index
      }));

    return {
      content: outputText,
      refused: (response.output || []).some(item =>
        (item.content || []).some(content => content.type === 'refusal')
      ),
      searchCalls: response.output?.filter(item => item.type === 'web_search_call').length,
      citations,
      model: response.model || options?.model || this.defaultModel,
      usage: response.usage
        ? {
            promptTokens: response.usage.input_tokens || 0,
            completionTokens: response.usage.output_tokens || 0,
            totalTokens: response.usage.total_tokens || 0
          }
        : undefined
    };
  }

  async analyzeImage(
    imageUrl: string,
    prompt: string,
    options?: ImageAnalysisOptions
  ): Promise<ImageAnalysisResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    // Use gpt-5-mini for vision tasks as well
    const response = await this.client.chat.completions.create({
      model: options?.model || this.defaultModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ],
      max_completion_tokens: options?.maxTokens || 500
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from OpenAI vision');
    }

    return {
      content: choice.message.content,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          }
        : undefined
    };
  }
}
