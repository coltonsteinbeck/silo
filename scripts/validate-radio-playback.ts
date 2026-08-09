import { RadioSourceResolver } from '../packages/bot/src/voice/radio/source';
import {
  PINNED_RADIO_FIXTURE_ID,
  PINNED_RADIO_FIXTURE_URL,
  PINNED_YTDLP_VERSION
} from './radio-validation-policy';

const resolver = new RadioSourceResolver();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
timeout.unref?.();
let playback: Awaited<ReturnType<RadioSourceResolver['preparePlayback']>> | null = null;
let resource: ReturnType<RadioSourceResolver['createAudioResource']> | null = null;

try {
  playback = await resolver.preparePlayback(PINNED_RADIO_FIXTURE_URL, {
    signal: controller.signal
  });
  resource = resolver.createAudioResource(playback, { title: 'Pinned radio validation fixture' });

  const encodedBytes = await new Promise<number>((resolve, reject) => {
    let settled = false;
    let packetTimeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (packetTimeout) clearTimeout(packetTimeout);
      resource?.playStream.off('data', onData);
      resource?.playStream.off('error', onError);
      resource?.playStream.off('end', onEnd);
      resource?.playStream.off('close', onEnd);
      callback();
    };
    const onData = (chunk: Buffer) => finish(() => resolve(Buffer.byteLength(chunk)));
    const onError = () => finish(() => reject(new Error('audio_transform_failed')));
    const onEnd = () => finish(() => reject(new Error('audio_transform_ended')));
    packetTimeout = setTimeout(() => {
      controller.abort();
      finish(() => reject(new Error('audio_transform_timeout')));
    }, 30_000);
    packetTimeout.unref?.();
    resource?.playStream.once('data', onData);
    resource?.playStream.once('error', onError);
    resource?.playStream.once('end', onEnd);
    resource?.playStream.once('close', onEnd);
  });

  if (encodedBytes <= 0) throw new Error('empty_audio_packet');
  console.log(
    `Radio transport ready: fixture=pinned media_id=${PINNED_RADIO_FIXTURE_ID} ` +
      `bun=${Bun.version} node=${process.versions.node} yt_dlp=${PINNED_YTDLP_VERSION} ` +
      `source=yt-dlp input=arbitrary encoded_bytes=${encodedBytes}`
  );
} catch {
  console.error('Radio transport validation failed: yt-dlp did not produce Discord-ready audio.');
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  try {
    resource?.playStream.destroy();
  } catch {
    // Resource already closed.
  }
  resolver.disposePlayback(playback);
}
