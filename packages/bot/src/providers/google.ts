import { logger } from '@silo/core';
import type { ImageProvider, ImageGenerationOptions, ImageGenerationResponse } from '@silo/core';

interface InlineImagePart {
  inline_data: {
    mime_type: string;
    data: string;
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

export class GoogleImageProvider implements ImageProvider {
  name = 'google';
  capabilities = { vision: false, maxImagesPerRequest: 1, maxImageReferences: 3 };

  private apiKey: string | null = null;
  private defaultModel: string;

  constructor(apiKey?: string, model: string = 'gemini-3.1-flash-image-preview') {
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

    const json = (await response.json()) as any;
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];

    const parts =
      candidates[0]?.content?.parts && Array.isArray(candidates[0].content.parts)
        ? candidates[0].content.parts
        : [];

    const imagePart = parts.find((part: any) => part.inlineData?.data);
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
        .filter((part: any) => typeof part.text === 'string')
        .map((part: any) => part.text.trim())
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
