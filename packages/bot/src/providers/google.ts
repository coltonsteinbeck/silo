import { logger } from '@silo/core';
import type {
  ImageProvider,
  ImageGenerationOptions,
  ImageGenerationResponse,
  TextProvider,
  Message,
  TextGenerationOptions,
  TextGenerationResponse
} from '@silo/core';

interface InlineImagePart {
  inline_data: {
    mime_type: string;
    data: string;
  };
}

interface GoogleGenerateContentPart {
  text?: string;
  inlineData?: {
    mimeType?: string;
    data?: string;
  };
}

interface GoogleGenerateContentCandidate {
  content?: {
    parts?: GoogleGenerateContentPart[];
  };
}

interface GoogleGenerateContentResponse {
  candidates?: GoogleGenerateContentCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function normalizeResolution(value: string | undefined): string {
  if (!value) {
    return '1K';
  }

  const upper = value.toUpperCase();
  if (upper === '512' || upper === '1K' || upper === '2K' || upper === '4K') {
    return upper;
  }

  return '1K';
}

async function fetchReferenceImageAsInlineData(url: string): Promise<InlineImagePart | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) {
      return null;
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 6 * 1024 * 1024) {
      return null;
    }

    const base64 = Buffer.from(bytes).toString('base64');
    return {
      inline_data: {
        mime_type: contentType,
        data: base64
      }
    };
  } catch {
    return null;
  }
}

/**
 * Google Gemini image generation provider
 * NOTE: Google now supports BOTH text generation and image generation
 * Use 'google' in /config provider for text generation
 * See GoogleTextProvider for text capabilities
 */
export class GoogleImageProvider implements ImageProvider {
  name = 'google';
  capabilities = {
    vision: false,
    maxImagesPerRequest: 1,
    maxImageReferences: 3
  };

  private apiKey: string | null = null;
  private defaultModel: string;

  constructor(apiKey?: string, model: string = 'gemini-3.1-flash-image') {
    this.defaultModel = model;
    if (apiKey) {
      this.apiKey = apiKey;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generateImage(
    prompt: string,
    options?: ImageGenerationOptions
  ): Promise<ImageGenerationResponse> {
    if (!this.apiKey) {
      throw new Error('Google provider not configured');
    }

    const model = options?.model || this.defaultModel;
    const references = (options?.referenceImages || []).slice(0, 3);

    const referenceParts: InlineImagePart[] = [];
    for (const ref of references) {
      const part = await fetchReferenceImageAsInlineData(ref);
      if (part) {
        referenceParts.push(part);
      }
    }

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, ...referenceParts]
        }
      ],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: options?.aspectRatio || '1:1',
          imageSize: normalizeResolution(options?.resolution)
        }
      }
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google image generation failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as GoogleGenerateContentResponse;
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];

    const parts =
      candidates[0]?.content?.parts && Array.isArray(candidates[0].content.parts)
        ? candidates[0].content.parts
        : [];

    const imagePart = parts.find(part => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      logger.warn('Google image response did not include inline image data', {
        model,
        candidateCount: candidates.length
      });
      throw new Error('Google image generation returned no image content');
    }

    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    const revisedPrompt =
      parts
        .filter(part => typeof part.text === 'string')
        .map(part => (part.text || '').trim())
        .filter(Boolean)
        .join('\n') || undefined;

    return {
      url: `data:${mimeType};base64,${imagePart.inlineData.data}`,
      revisedPrompt,
      model,
      moderationPassed: true
    };
  }
}

/**
 * Google Gemini text generation provider
 * Supports text chat and reasoning with the Gemini API
 */
export class GoogleTextProvider implements TextProvider {
  name = 'google';
  capabilities = {
    vision: false
  };

  private apiKey: string | null = null;
  private defaultModel: string;

  constructor(apiKey?: string, model: string = 'gemini-3.1-flash-lite') {
    this.defaultModel = model;
    if (apiKey) {
      this.apiKey = apiKey;
    }
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generateText(
    messages: Message[],
    options?: TextGenerationOptions
  ): Promise<TextGenerationResponse> {
    if (!this.apiKey) {
      throw new Error('Google provider not configured');
    }

    const model = options?.model || this.defaultModel;
    const maxTokens = options?.maxTokens || 2048;

    // Separate system messages (which include safety-validated guild prompts) from conversation
    const systemMessages = messages.filter(msg => msg.role === 'system');
    const conversationMessages = messages.filter(msg => msg.role !== 'system');

    // Concatenate all system messages (typically one, but handle multiple if present)
    const systemInstruction =
      systemMessages.length > 0 ? systemMessages.map(msg => msg.content).join('\n\n') : undefined;

    // Convert conversation messages to Gemini format (system already handled)
    const contents = conversationMessages.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const requestBody: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: options?.temperature ?? 1.0,
        topP: 0.9,
        topK: 40
      }
    };

    // Add system instruction if present (preserves safety-validated guild custom prompts)
    // Google's API expects system_instruction as a Content object with parts, not a plain string
    if (systemInstruction) {
      requestBody.system_instruction = {
        parts: [
          {
            text: systemInstruction
          }
        ]
      };
    }

    // Add thinking level configuration if specified (Gemini 3 uses thinking_level instead of thinking_budget)
    if (options?.reasoning) {
      if (options.reasoning.type === 'enabled') {
        requestBody.thinking_config = {
          thinking_level: 'high'
        };
      } else if (options.reasoning.type === 'budgeted') {
        // For budgeted mode, use lower thinking level for cost efficiency
        requestBody.thinking_config = {
          thinking_level: 'low'
        };
      }
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google text generation failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as GoogleGenerateContentResponse;
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];

    const parts =
      candidates[0]?.content?.parts && Array.isArray(candidates[0].content.parts)
        ? candidates[0].content.parts
        : [];

    const textContent = parts
      .filter(part => typeof part.text === 'string')
      .map(part => (part.text || '').trim())
      .filter(Boolean)
      .join('\n');

    if (!textContent) {
      logger.warn('Google text generation response did not include text content', {
        model,
        candidateCount: candidates.length
      });
      throw new Error('Google text generation returned no text content');
    }

    // Use actual token counts from API response if available
    let promptTokens: number;
    let completionTokens: number;
    let totalTokens: number;

    if (json.usageMetadata) {
      promptTokens = json.usageMetadata.promptTokenCount ?? 0;
      completionTokens = json.usageMetadata.candidatesTokenCount ?? 0;
      totalTokens = json.usageMetadata.totalTokenCount ?? promptTokens + completionTokens;
    } else {
      // Fallback to character-based estimation if usageMetadata not available
      promptTokens = Math.ceil(messages.reduce((sum, msg) => sum + msg.content.length, 0) / 4);
      completionTokens = Math.ceil(textContent.length / 4);
      totalTokens = promptTokens + completionTokens;
    }

    return {
      content: textContent,
      model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens
      }
    };
  }
}
