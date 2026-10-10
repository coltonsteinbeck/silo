import { spawn, type SpawnOptions } from 'node:child_process';
import { RadioSourceResolver } from '../packages/bot/src/voice/radio/source';
import {
  PINNED_RADIO_FIXTURE_ID,
  PINNED_RADIO_FIXTURE_URL,
  PINNED_YTDLP_VERSION
} from './radio-validation-policy';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--offline')) throw new Error('Unknown radio validation option');
const offline = args.includes('--offline');

function emitValidationWave(): void {
  const sampleRate = 48_000;
  const frames = 4_800;
  const bytes = frames * 4;
  const wave = Buffer.alloc(44 + bytes);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(36 + bytes, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 4, 28);
  wave.writeUInt16LE(4, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(bytes, 40);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(4_000 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate));
    wave.writeInt16LE(sample, 44 + frame * 4);
    wave.writeInt16LE(sample, 46 + frame * 4);
  }
  process.stdout.write(wave);
}

// CI exercises the real preparation/FFmpeg/Opus pipeline without depending on
// public media access. The default command retains the live yt-dlp smoke check.
const resolver = new RadioSourceResolver(
  offline
    ? {
        resolveExecutable: () => process.execPath,
        spawnProcess: ((_: string, __: readonly string[], options: SpawnOptions) =>
          spawn(
            process.execPath,
            ['--eval', `(${emitValidationWave.toString()})()`],
            options
          )) as typeof spawn
      }
    : {}
);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
timeout.unref?.();
let playback: Awaited<ReturnType<RadioSourceResolver['preparePlayback']>> | null = null;
let resource: ReturnType<RadioSourceResolver['createAudioResource']> | null = null;

try {
  playback = await resolver.preparePlayback(PINNED_RADIO_FIXTURE_URL, {
    signal: controller.signal
  });
  resource = resolver.createAudioResource(playback, {
    title: offline ? 'Generated radio validation fixture' : 'Pinned radio validation fixture'
  });

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
    `Radio transport ready: fixture=${offline ? 'generated-pcm' : 'pinned'} ` +
      (offline ? '' : `media_id=${PINNED_RADIO_FIXTURE_ID} `) +
      `bun=${Bun.version} node=${process.versions.node} yt_dlp=${PINNED_YTDLP_VERSION} ` +
      `source=${offline ? 'synthetic-pcm' : 'yt-dlp'} input=arbitrary encoded_bytes=${encodedBytes}`
  );
} catch {
  console.error(
    `Radio transport validation failed: ${offline ? 'generated PCM' : 'yt-dlp'} did not produce Discord-ready audio.`
  );
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
