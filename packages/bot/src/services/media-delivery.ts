import { AttachmentBuilder } from 'discord.js';
import type { AgentMediaResult } from '../agent/tool-executor';

export const DEFAULT_INLINE_MEDIA_LIMIT_BYTES = 24 * 1024 * 1024;

export interface MediaReplyPayload {
  content?: string;
  files: AttachmentBuilder[];
  uploaded: boolean;
  failureReason?: string;
}

export interface MediaDeliveryOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  now?: () => number;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);

function failureMessage(kind: AgentMediaResult['kind']): string {
  return `Could not upload ${kind} inline. Please try again in a moment.`;
}

export function resolveDeliverableMediaResult(
  media: AgentMediaResult | null | undefined,
  outputBlockedBySafety: boolean
): AgentMediaResult | null {
  if (outputBlockedBySafety) {
    return null;
  }

  return media || null;
}

export function inferMediaExtension(
  kind: AgentMediaResult['kind'],
  url: string,
  contentType?: string
): string {
  const lowerType = (contentType || '').toLowerCase();
  if (lowerType.includes('png')) return 'png';
  if (lowerType.includes('jpeg') || lowerType.includes('jpg')) return 'jpg';
  if (lowerType.includes('webp')) return 'webp';
  if (lowerType.includes('gif')) return 'gif';
  if (lowerType.includes('mp4')) return 'mp4';
  if (lowerType.includes('webm')) return 'webm';
  if (lowerType.includes('quicktime')) return 'mov';

  const pathPart = url.split('?')[0] || '';
  const ext = pathPart.split('.').pop()?.toLowerCase();
  if (ext) {
    const allowed = kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
    if (allowed.has(ext)) {
      return ext;
    }
  }

  return kind === 'image' ? 'png' : 'mp4';
}

function buildAttachment(
  media: AgentMediaResult,
  buffer: Buffer,
  extension: string,
  now: () => number
): AttachmentBuilder {
  const prefix = media.kind === 'image' ? 'agent-image' : 'agent-video';
  return new AttachmentBuilder(buffer, { name: `${prefix}-${now()}.${extension}` });
}

function dataImageToAttachment(
  media: AgentMediaResult,
  now: () => number
): MediaReplyPayload | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(media.url);
  if (!match) {
    return null;
  }

  const contentType = match[1];
  const base64Data = match[2];
  if (!base64Data) {
    return {
      content: failureMessage(media.kind),
      files: [],
      uploaded: false,
      failureReason: 'media data URL did not include base64 content'
    };
  }

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.byteLength === 0) {
    return {
      content: failureMessage(media.kind),
      files: [],
      uploaded: false,
      failureReason: 'media data URL decoded to empty content'
    };
  }

  return {
    files: [
      buildAttachment(media, buffer, inferMediaExtension(media.kind, media.url, contentType), now)
    ],
    uploaded: true
  };
}

export async function buildMediaReplyPayload(
  media: AgentMediaResult,
  options: MediaDeliveryOptions = {}
): Promise<MediaReplyPayload> {
  const now = options.now || Date.now;
  const maxBytes = options.maxBytes || DEFAULT_INLINE_MEDIA_LIMIT_BYTES;

  const dataImagePayload = dataImageToAttachment(media, now);
  if (dataImagePayload) {
    return dataImagePayload;
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    return {
      content: failureMessage(media.kind),
      files: [],
      uploaded: false,
      failureReason: 'fetch is not available'
    };
  }

  try {
    const response = await fetchImpl(media.url);
    if (!response.ok) {
      return {
        content: failureMessage(media.kind),
        files: [],
        uploaded: false,
        failureReason: `${media.kind} fetch failed (${response.status})`
      };
    }

    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        content: failureMessage(media.kind),
        files: [],
        uploaded: false,
        failureReason: `${media.kind} file is too large for inline upload`
      };
    }

    const contentType = response.headers.get('content-type') || undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0) {
      return {
        content: failureMessage(media.kind),
        files: [],
        uploaded: false,
        failureReason: `${media.kind} download returned empty content`
      };
    }

    if (buffer.byteLength > maxBytes) {
      return {
        content: failureMessage(media.kind),
        files: [],
        uploaded: false,
        failureReason: `${media.kind} file is too large for inline upload`
      };
    }

    return {
      files: [
        buildAttachment(media, buffer, inferMediaExtension(media.kind, media.url, contentType), now)
      ],
      uploaded: true
    };
  } catch (error) {
    return {
      content: failureMessage(media.kind),
      files: [],
      uploaded: false,
      failureReason: error instanceof Error ? error.message : 'unknown media download error'
    };
  }
}
