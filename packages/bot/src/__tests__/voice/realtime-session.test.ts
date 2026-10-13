import { describe, expect, mock, test } from 'bun:test';
import { RealtimeSession } from '../../voice/realtime-session';
import { VoiceOutputGate } from '../../voice/output-gate';
import { PassThrough } from 'node:stream';
import { EventEmitter, once } from 'node:events';
import { OpusEncoder } from 'mediaplex';

function setup(approve = async () => true) {
  const delivered = mock(() => {});
  const session = new RealtimeSession('test', 'user', { onAudioResponse: delivered });
  const sent: any[] = [];
  const internal = session as any;
  internal.ws = {
    readyState: 1,
    send: (value: string) => sent.push(JSON.parse(value)),
    close: () => {}
  };
  internal.outputGate = new VoiceOutputGate(approve, delivered);
  const event = (value: unknown) => internal.handleMessage(Buffer.from(JSON.stringify(value)));
  internal.requestResponse();
  const token = sent[0].response.metadata.turn_id;
  return { session, internal, delivered, sent, event, token };
}

describe('Realtime GA session', () => {
  test.each(['stale', 'empty'])('deletes %s unapproved input from provider history', async kind => {
    const { session, internal, sent, event } = setup();
    internal.latestInputItemId = 'current';
    const id = kind === 'stale' ? 'previous' : 'current';
    event({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: id,
      transcript: kind === 'empty' ? '' : 'old utterance'
    });
    expect(sent.at(-1)).toEqual({ type: 'conversation.item.delete', item_id: id });
    await session.disconnect();
  });

  test('delivers trailing silence when Discord ends a captured utterance', async () => {
    const { session, internal, sent } = setup();
    const stream = new PassThrough();
    internal.connection = { receiver: { subscribe: () => stream } };
    internal.startRecording();
    const encoder = new OpusEncoder(48000, 2);
    const pcm = Buffer.alloc(3840);
    for (let offset = 0; offset < pcm.length; offset += 2)
      pcm.writeInt16LE(Math.round(8000 * Math.sin(offset / 20)), offset);
    stream.write(encoder.encode(pcm));
    const ended = once(stream, 'end');
    stream.end();
    await ended;
    const chunks = sent
      .filter(message => message.type === 'input_audio_buffer.append')
      .map(message => Buffer.from(message.audio, 'base64'));
    expect(chunks[0]!.some((byte: number) => byte !== 0)).toBe(true);
    // Discord sends no packets during a pause. The provider still needs enough
    // PCM silence to finish its 500 ms VAD window without a second utterance.
    expect(chunks.at(-1)?.length).toBeGreaterThanOrEqual(24000 * 2 * 0.5);
    expect(chunks.at(-1)?.every((byte: number) => byte === 0)).toBe(true);
    expect(sent.some(message => message.type === 'input_audio_buffer.commit')).toBe(false);
    internal.connection = null;
    await session.disconnect();
  });

  test('subscribes when the user is already speaking at attachment', async () => {
    const { session, internal } = setup();
    const stream = new PassThrough();
    const speaking = Object.assign(new EventEmitter(), { users: new Map([['user', 1]]) });
    const subscribe = mock(() => stream);
    internal.connection = { receiver: { speaking, subscribe } };
    internal.startListening();
    expect(subscribe).toHaveBeenCalledTimes(1);
    await session.disconnect();
  });

  test('empty and interrupted captures cannot flush or disrupt the next utterance', async () => {
    const { session, internal, sent } = setup();
    const streams = [new PassThrough(), new PassThrough()];
    let index = 0;
    const speaking = Object.assign(new EventEmitter(), { users: new Map() });
    internal.connection = { receiver: { speaking, subscribe: () => streams[index++] } };
    internal.startRecording();
    const ended = once(streams[0]!, 'end');
    streams[0]!.end();
    await ended;
    internal.startRecording();
    streams[0]!.emit('close');
    expect(internal.currentAudioStream).toBe(streams[1]);
    await session.disconnect();
    streams[1]!.emit('end');
    expect(sent.some(message => message.type === 'input_audio_buffer.append')).toBe(false);
  });
  test('uses the GA audio shape with automatic response generation disabled', async () => {
    const { session, internal, sent } = setup();
    internal.configureSession();
    expect(sent.at(-1).session).toMatchObject({
      type: 'realtime',
      max_output_tokens: 1024,
      output_modalities: ['audio'],
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: { create_response: false }
        },
        output: { voice: 'alloy' }
      }
    });
    expect(sent.at(-1).session.modalities).toBeUndefined();
    expect(sent.at(-1).session.max_response_output_tokens).toBeUndefined();
    await session.disconnect();
  });
  test('binds audio to the requested response and approves before delivery', async () => {
    const { session, internal, event, delivered, token, sent } = setup();
    event({ type: 'response.created', response: { id: 'r', metadata: { turn_id: token } } });
    event({ type: 'response.output_audio.delta', response_id: 'stale', delta: 'AAAAAA==' });
    event({ type: 'response.output_audio.delta', response_id: 'r', delta: 'AAAAAA==' });
    expect(delivered).not.toHaveBeenCalled();
    const response = {
      id: 'r',
      status: 'completed',
      output: [{ id: 'item', type: 'message', content: [{ transcript: 'Hello' }] }]
    };
    await internal.finishVoiceResponse(response);
    await internal.finishVoiceResponse(response);
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(sent.some(message => message.type === 'conversation.item.delete')).toBe(false);
    await session.disconnect();
  });
  test('rejects unsolicited responses and deletes rejected output from provider history', async () => {
    const { session, internal, event, delivered, token, sent } = setup(async () => false);
    event({ type: 'response.created', response: { id: 'unexpected', metadata: {} } });
    expect(sent.at(-1)).toMatchObject({ type: 'response.cancel', response_id: 'unexpected' });
    event({ type: 'response.created', response: { id: 'r', metadata: { turn_id: token } } });
    event({ type: 'response.output_audio.delta', response_id: 'r', delta: 'AAAAAA==' });
    await internal.finishVoiceResponse({
      id: 'r',
      status: 'completed',
      output: [{ id: 'blocked', type: 'message', content: [{ transcript: 'Rejected' }] }]
    });
    expect(delivered).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({ type: 'conversation.item.delete', item_id: 'blocked' });
    await session.disconnect();
  });
});
