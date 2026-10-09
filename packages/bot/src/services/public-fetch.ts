import * as dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20]
] as const)
  specialV6.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  return isIP(address) === 4
    ? !blockedAddresses.check(address, 'ipv4')
    : isIP(address) === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}

/** Fetch a screened origin without a second DNS lookup or proxy resolution. */
export async function fetchPublicUrl(
  parsed: URL,
  options: { signal: AbortSignal; headers?: Record<string, string>; redirect: 'manual' | 'error' }
): Promise<Response> {
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '80' && parsed.port !== '443')
  )
    throw new Error('URL origin is not allowed');
  const { signal } = options;
  signal.throwIfAborted();
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await new Promise<LookupAddress[]>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        dns
          .lookup(hostname, { all: true })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', onAbort));
      });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new Error('URL address is not public');
  const address = addresses[0]!;
  const pinned = new URL(parsed);
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  const requestOptions = {
    ...options,
    headers: { ...options.headers, Host: parsed.host },
    tls: { serverName: hostname },
    proxy: false
  };
  return fetch(pinned, requestOptions);
}

/** Enforce the limit on bytes actually received, independent of response headers. */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number
): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response exceeds size limit');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
