import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming
} from 'openai/resources/chat/completions';
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

type OpenAIImageToolQuality = 'auto' | 'high' | 'medium' | 'low';
type OpenAIImageToolAction = 'auto' | 'generate' | 'edit';
type OpenAIImageToolInputFidelity = 'low' | 'high';

type OpenAIResponsesInputText = {
  type: 'input_text';
  text: string;
};

type OpenAIResponsesInputImage = {
  type: 'input_image';
  image_url: string;
};

type OpenAIResponsesInputContent = OpenAIResponsesInputText | OpenAIResponsesInputImage;

interface OpenAIResponsesCreateRequest {
  model: string;
  input: Array<{
    role: 'user';
    content: OpenAIResponsesInputContent[];
  }>;
  tools: Array<{
    type: 'image_generation';
    size: string;
    quality: OpenAIImageToolQuality;
    action: OpenAIImageToolAction;
    input_fidelity?: OpenAIImageToolInputFidelity;
  }>;
}

interface OpenAIImageGenerationCall {
  type?: string;
  status?: string;
  result?: string;
  revised_prompt?: string;
}

interface OpenAIResponsesCreateResult {
  output?: OpenAIImageGenerationCall[];
}

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

type OpenAIReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

const MAX_OPENAI_OUTPUT_TOKENS = 16000;

function toReasoningEffort(
  reasoning: TextGenerationOptions['reasoning']
): OpenAIReasoningEffort | null {
  if (!reasoning) {
    return null;
  }

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

  constructor(apiKey?: string, model: string = 'gpt-5.4-nano', imageModel: string = 'gpt-image-1') {
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

    // Build request payload
    const requestParams: Record<string, unknown> = {
      model: options?.model || this.defaultModel,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      temperature: options?.temperature ?? 0.8,
      stream: false
    };

    let maxOutputTokens =
      typeof options?.maxTokens === 'number' ? clampOutputTokens(options.maxTokens) : undefined;

    // chat.completions for GPT-5 models expects max_completion_tokens
    if (options?.reasoning) {
      const effort = toReasoningEffort(options.reasoning);
      if (effort) {
        requestParams.reasoning = { effort };
      }

      if (options.reasoning.type === 'budgeted' && typeof options.reasoning.budget === 'number') {
        const budgetCap = clampOutputTokens(options.reasoning.budget);
        maxOutputTokens =
          typeof maxOutputTokens === 'number' ? Math.min(maxOutputTokens, budgetCap) : budgetCap;
      }
    }

    if (typeof maxOutputTokens === 'number') {
      requestParams.max_completion_tokens = maxOutputTokens;
    }

    const response = await this.client.chat.completions.create(
      requestParams as unknown as ChatCompletionCreateParamsNonStreaming
    );

    // Type guard: stream is false, so response is ChatCompletion, not Stream
    const chatResponse = response as ChatCompletion & { _request_id?: string | null };

    const choice = chatResponse.choices[0];
    if (!choice?.message?.content) {
      throw new Error('No response from OpenAI');
    }

    // Extract thinking content if available (for models with extended thinking)
    const thinking = (choice.message as unknown as Record<string, unknown>).reasoning as
      | string
      | undefined;

    return {
      content: choice.message.content,
      thinking,
      usage: chatResponse.usage
        ? {
            promptTokens: chatResponse.usage.prompt_tokens,
            completionTokens: chatResponse.usage.completion_tokens,
            totalTokens: chatResponse.usage.total_tokens,
            reasoningTokens: (chatResponse.usage as unknown as Record<string, unknown>)
              .reasoning_tokens as number | undefined,
            cacheCreationTokens: (chatResponse.usage as unknown as Record<string, unknown>)
              .cache_creation_input_tokens as number | undefined,
            cacheReadTokens: (chatResponse.usage as unknown as Record<string, unknown>)
              .cache_read_input_tokens as number | undefined
          }
        : undefined,
      model: chatResponse.model
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

      if (references.length > 0) {
        const tool: OpenAIResponsesCreateRequest['tools'][number] = {
          type: 'image_generation',
          size: options?.size || '1024x1024',
          quality: (options?.quality as OpenAIImageToolQuality) || 'auto',
          action: options?.action || 'edit'
        };

        if (options?.inputFidelity) {
          tool.input_fidelity = options.inputFidelity;
        }

        const createResponse = this.client.responses.create as unknown as (
          request: OpenAIResponsesCreateRequest
        ) => Promise<OpenAIResponsesCreateResult>;

        const response = await createResponse({
          model: options?.model || this.defaultImageModel,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: prompt },
                ...references.map<OpenAIResponsesInputImage>(imageUrl => ({
                  type: 'input_image',
                  image_url: imageUrl
                }))
              ]
            }
          ],
          tools: [tool]
        });

        const output = Array.isArray(response.output) ? response.output : [];
        const imageCall = output.find(item => item.type === 'image_generation_call');
        if (!imageCall?.result) {
          throw new Error('No image output from OpenAI response tool call');
        }

        return {
          url: `data:image/png;base64,${imageCall.result}`,
          revisedPrompt: imageCall.revised_prompt,
          model: options?.model || this.defaultImageModel
        };
      }

      logger.info('[OpenAI] Generating image:', {
        model: options?.model || this.defaultImageModel,
        prompt: prompt.substring(0, 100),
        size: options?.size,
        quality: options?.quality
      });

      const response = await this.client.images.generate({
        model: options?.model || this.defaultImageModel,
        prompt,
        n: 1,
        size: toOpenAIImageSize(options?.size),
        quality: (options?.quality as 'auto' | 'high' | 'medium' | 'low') || 'auto'
      });

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
      throw new Error(`OpenAI image generation failed: ${message}`);
    }
  }

  async searchWeb(query: string, options?: WebSearchOptions): Promise<WebSearchResponse> {
    if (!this.client) {
      throw new Error('OpenAI provider not configured');
    }

    const model = options?.model || this.defaultModel;
    let response: OpenAIWebSearchResult;

    try {
      response = (await this.client.responses.create({
        model,
        input: query,
        tools: [{ type: 'web_search' }],
        max_output_tokens: 1200
      } as any)) as OpenAIWebSearchResult;
    } catch (error) {
      logger.error('[OpenAI] Web search failed', {
        query,
        model,
        error
      });
      throw error;
    }

    const outputText =
      response.output_text ||
      (response.output || [])
        .flatMap(item => item.content || [])
        .map(item => item.text || '')
        .join('')
        .trim();

    const citations = (response.output || [])
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

    if (!outputText) {
      throw new Error('OpenAI web search returned no answer text');
    }

    return {
      content: outputText,
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
