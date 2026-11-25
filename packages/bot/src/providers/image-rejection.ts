import { APIError } from 'openai';

export interface ImageModelRejectionEvidence {
  provider: 'openai';
  status: 400 | 404;
  code: 'model_not_found';
  requestId: string;
}

/** A structured response proving the requested image model was rejected. */
export class ImageModelRejectedBeforeGenerationError extends Error {
  readonly evidence: ImageModelRejectionEvidence;

  constructor(evidence: ImageModelRejectionEvidence) {
    super('Image model unavailable to this provider account');
    this.name = 'ImageModelRejectedBeforeGenerationError';
    this.evidence = evidence;
  }
}

export function classifyOpenAIImageModelRejection(
  error: unknown
): ImageModelRejectedBeforeGenerationError | null {
  if (!(error instanceof APIError)) return null;
  if (error.status !== 400 && error.status !== 404) return null;
  if (error.code !== 'model_not_found') return null;
  if (error.param != null && error.param !== 'model') return null;
  if (!error.requestID || !/^[A-Za-z0-9_-]{1,128}$/.test(error.requestID)) return null;
  return new ImageModelRejectedBeforeGenerationError({
    provider: 'openai',
    status: error.status,
    code: 'model_not_found',
    requestId: error.requestID
  });
}
