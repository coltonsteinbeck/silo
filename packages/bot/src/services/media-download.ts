import { screenExternalUrl } from './url-context';
import { fetchPublicUrl, readBoundedResponseBody } from './public-fetch';
export { isPublicAddress as isPublicMediaAddress } from './public-fetch';

export async function downloadMedia(
  url: string,
  options: { maxBytes: number; signal?: AbortSignal }
): Promise<{ bytes: Buffer; contentType: string }> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : [])
  ]);
  signal.throwIfAborted();
  const data = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (data) {
    if (!data[2] || data[2].length > Math.ceil(options.maxBytes / 3) * 4)
      throw new Error('Media exceeds size limit');
    const bytes = Buffer.from(data[2], 'base64');
    if (!bytes.length || bytes.length > options.maxBytes) throw new Error('Invalid media size');
    return { bytes, contentType: data[1]! };
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' ||
    (parsed.port && parsed.port !== '443') ||
    parsed.username ||
    parsed.password ||
    !(await screenExternalUrl(url)).allowed
  ) {
    throw new Error('Media URL is not allowed');
  }
  const response = await fetchPublicUrl(parsed, { signal, redirect: 'error' });
  return readBoundedMediaResponse(response, options.maxBytes);
}

export async function readBoundedMediaResponse(
  response: Response,
  maxBytes: number
): Promise<{ bytes: Buffer; contentType: string }> {
  const length = Number(response.headers.get('content-length'));
  const contentType = (response.headers.get('content-type') || '').split(';')[0]!;
  if (response.status !== 200 || !/^(image|video)\//.test(contentType) || length > maxBytes) {
    await response.body?.cancel();
    throw new Error('Media download rejected');
  }
  const bytes = await readBoundedResponseBody(response, maxBytes);
  if (!bytes.length) throw new Error('Empty media');
  return { bytes, contentType };
}
