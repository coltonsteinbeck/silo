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
}

export interface ImageGenerationResponse {
  url: string;
  revisedPrompt?: string;
}

export interface ImageAnalysisOptions {
  model?: string;
  maxTokens?: number;
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

export interface EmbeddingProvider extends BaseProvider {
  generateEmbedding(text: string): Promise<number[]>;
  generateEmbeddings(texts: string[]): Promise<number[][]>;
}

export type ProviderType = 'text' | 'image' | 'embedding';
