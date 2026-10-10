import { describe, expect, test } from 'bun:test';
import {
  downloadMedia,
  isPublicMediaAddress,
  readBoundedMediaResponse
} from '../../services/media-download';

describe('bounded media download', () => {
  test.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.2.3.4',
    '169.254.169.254',
    '100.64.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::1',
    '3fff::1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1'
  ])('rejects non-public resolved address %s', address => {
    expect(isPublicMediaAddress(address)).toBe(false);
  });
  test('accepts public address families', () => {
    expect(isPublicMediaAddress('8.8.8.8')).toBe(true);
    expect(isPublicMediaAddress('2606:4700:4700::1111')).toBe(true);
  });
  test('enforces data-image bounds before upload', async () => {
    const url = 'data:image/png;base64,aGVsbG8=';
    expect((await downloadMedia(url, { maxBytes: 10 })).bytes.toString()).toBe('hello');
    await expect(downloadMedia(url, { maxBytes: 2 })).rejects.toThrow();
    await expect(
      downloadMedia(url, { maxBytes: 10, signal: AbortSignal.abort() })
    ).rejects.toThrow();
  });
  test.each([
    'http://example.com/a.png',
    'https://user:pass@example.com/a.png',
    'https://localhost/a.png'
  ])('rejects an unsafe URL before connecting: %s', async url => {
    await expect(downloadMedia(url, { maxBytes: 10 })).rejects.toThrow();
  });
});

test('remote response reads enforce type, status, and streamed byte limits', async () => {
  const media = () => new Response('sample', { headers: { 'content-type': 'video/mp4' } });
  expect((await readBoundedMediaResponse(media(), 6)).bytes.toString()).toBe('sample');
  await expect(readBoundedMediaResponse(media(), 5)).rejects.toThrow('size limit');
  await expect(readBoundedMediaResponse(new Response('html'), 100)).rejects.toThrow('rejected');
  await expect(readBoundedMediaResponse(new Response(null, { status: 302 }), 100)).rejects.toThrow(
    'rejected'
  );
  await expect(
    readBoundedMediaResponse(new Response('', { headers: { 'content-type': 'image/png' } }), 100)
  ).rejects.toThrow('Empty');
});
