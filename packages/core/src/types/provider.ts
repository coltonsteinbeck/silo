export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TextGenerationOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface TextGenerationResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

export interface ImageGenerationOptions {
  model?: string;
  size?: string;
  quality?: string;
  style?: string;
  aspectRatio?: string;
  resolution?: string;
  referenceImages?: string[];
  action?: 'auto' | 'generate' | 'edit';
  inputFidelity?: 'low' | 'high';
}

export interface ImageGenerationResponse {
  url: string;
  revisedPrompt?: string;
  model?: string;
  moderationPassed?: boolean;
}

export interface VideoGenerationOptions {
  model?: string;
  duration?: number;
  aspectRatio?: string;
  resolution?: string;
  referenceImages?: string[];
  count?: number;
}

export interface VideoGenerationResponse {
  url: string;
  model?: string;
  duration?: number;
  moderationPassed?: boolean;
}

export interface ImageAnalysisOptions {
  model?: string;
  maxTokens?: number;
}

export interface ProviderCapabilities {
  vision: boolean;
  maxImagesPerRequest?: number;
  maxImageReferences?: number;
  maxVideoReferences?: number;
  videoGeneration?: boolean;
}

export interface ImageAnalysisResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface BaseProvider {
  name: string;
  capabilities?: ProviderCapabilities;
  isConfigured(): boolean;
}

export interface TextProvider extends BaseProvider {
  generateText(
    messages: Message[],
    options?: TextGenerationOptions
  ): Promise<TextGenerationResponse>;
}

export interface ImageProvider extends BaseProvider {
  generateImage(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResponse>;
  analyzeImage?(
    imageUrl: string,
    prompt: string,
    options?: ImageAnalysisOptions
  ): Promise<ImageAnalysisResponse>;
}

export interface VideoProvider extends BaseProvider {
  generateVideo(prompt: string, options?: VideoGenerationOptions): Promise<VideoGenerationResponse>;
}

export interface EmbeddingProvider extends BaseProvider {
  generateEmbedding(text: string): Promise<number[]>;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
}

export type ProviderType = 'text' | 'image' | 'video' | 'embedding';
