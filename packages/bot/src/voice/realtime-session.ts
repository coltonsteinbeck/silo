import WebSocket from 'ws';
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  EndBehaviorType
} from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import { Readable } from 'stream';
import { OpusEncoder } from 'mediaplex';

const REALTIME_API_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';

interface RealtimeSessionOptions {
  onAudioResponse?: (audio: Buffer) => void;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  voice?: string;
  instructions?: string;
}

interface AudioChunk {
  data: Buffer;
  timestamp: number;
}

/**
 * Manages a single WebSocket connection to OpenAI's Realtime API.
 * Handles audio streaming in both directions and voice synthesis.
 */
export class RealtimeSession {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private userId: string;
  private options: RealtimeSessionOptions;
  private audioPlayer = createAudioPlayer();
  private audioQueue: AudioChunk[] = [];
  private isPlaying = false;
  private connection: VoiceConnection | null = null;
  private isListening = false;
  private currentAudioStream: Readable | null = null;
  private opusDecoder: OpusEncoder | null = null;

  constructor(apiKey: string, userId: string, options: RealtimeSessionOptions = {}) {
    this.apiKey = apiKey;
    this.userId = userId;
    this.options = {
      voice: 'alloy',
      instructions:
        'You are a helpful AI assistant in a Discord voice channel. Keep responses concise and conversational.',
      ...options
    };

    this.setupAudioPlayer();
  }

  /**
   * Setup the audio player for playing responses
   */
  private setupAudioPlayer(): void {
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
      this.playNextInQueue();
    });

    this.audioPlayer.on('error', (error: Error) => {
      console.error('[RealtimeSession] Audio player error:', error);
      this.isPlaying = false;
      this.playNextInQueue();
    });
  }

  /**
   * Connect to the OpenAI Realtime API
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(REALTIME_API_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.ws?.close();
      }, 30000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.configureSession();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        console.error('[RealtimeSession] WebSocket error:', error);
        this.options.onError?.(error);
        reject(error);
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        this.options.onClose?.();
      });
    });
  }

  /**
   * Configure the session after connection
   */
  private configureSession(): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.options.instructions,
        voice: this.options.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    });
  }

  /**
   * Handle incoming messages from the API
   */
  private handleMessage(data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'session.created':
        case 'session.updated':
          // Session is ready
          break;

        case 'response.audio.delta':
          // Received audio chunk
          if (message.delta) {
            const audioBuffer = Buffer.from(message.delta, 'base64');
            this.queueAudio(audioBuffer);
            this.options.onAudioResponse?.(audioBuffer);
          }
          break;

        case 'response.audio_transcript.delta':
          // Partial transcript of AI response
          if (message.delta) {
            this.options.onTranscript?.(message.delta, false);
          }
          break;

        case 'response.audio_transcript.done':
          // Final transcript of AI response
          if (message.transcript) {
            this.options.onTranscript?.(message.transcript, true);
          }
          break;

        case 'input_audio_buffer.speech_started':
          // User started speaking - interrupt any playing audio
          this.interruptPlayback();
          break;

        case 'input_audio_buffer.speech_stopped':
          // User stopped speaking
          break;

        case 'conversation.item.input_audio_transcription.completed':
          // Transcription of user's speech is complete
          console.log('[RealtimeSession] User said:', message.transcript);
          break;

        case 'error': {
          // Ignore non-critical errors
          const errorCode = message.error?.code;
          if (errorCode === 'response_cancel_not_active') {
            // This just means we tried to cancel when no response was active - not an error
            break;
          }
          console.error('[RealtimeSession] API error:', message.error);
          this.options.onError?.(new Error(message.error?.message || 'Unknown error'));
          break;
        }

        default:
          // Log unknown message types for debugging
          if (process.env.DEBUG_VOICE) {
            console.log('[RealtimeSession] Unknown message type:', message.type);
          }
      }
    } catch (error) {
      console.error('[RealtimeSession] Error parsing message:', error);
    }
  }

  /**
   * Send a message to the API
   */
  private send(message: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send audio data to the API (from user's microphone)
   * Audio should be PCM16, 24kHz, mono
   */
  sendAudio(audio: Buffer): void {
    const base64Audio = audio.toString('base64');
    this.send({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    });
  }

  /**
   * Commit the audio buffer and trigger a response
   */
  commitAudio(): void {
    this.send({
      type: 'input_audio_buffer.commit'
    });
  }

  /**
   * Send a text message for the AI to respond to (with voice)
   */
  sendText(text: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text
          }
        ]
      }
    });

    // Trigger response generation
    this.send({
      type: 'response.create'
    });
  }

  /**
   * Send a greeting message that the AI will speak aloud
   * Used when the bot first joins a voice channel
   */
  sendGreeting(greeting?: string): void {
    const defaultGreeting =
      'Introduce yourself briefly and explain that you can answer questions, help with tasks, and have natural conversations. Keep it under 15 seconds.';

    // Create a system-like instruction for the greeting
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: greeting || defaultGreeting
          }
        ]
      }
    });

    // Trigger the greeting response
    this.send({
      type: 'response.create'
    });
  }

  /**
   * Queue audio for playback
   */
  private queueAudio(audio: Buffer): void {
    this.audioQueue.push({
      data: audio,
      timestamp: Date.now()
    });

    if (!this.isPlaying) {
      this.playNextInQueue();
    }
  }

  /**
   * Play the next audio chunk in the queue
   */
  private playNextInQueue(): void {
    if (this.audioQueue.length === 0 || !this.connection) {
      return;
    }

    // Combine all queued audio into one buffer for smoother playback
    const combinedAudio = Buffer.concat(this.audioQueue.map(c => c.data));
    this.audioQueue = [];

    // Convert PCM16 to audio resource
    // OpenAI outputs 24kHz mono PCM16, Discord expects 48kHz stereo PCM16
    const convertedAudio = this.convertTo48kHzStereo(combinedAudio);

    const audioStream = Readable.from(convertedAudio);
    const resource = createAudioResource(audioStream, {
      inputType: StreamType.Raw
    });

    this.isPlaying = true;
    this.audioPlayer.play(resource);
  }

  /**
   * Convert 24kHz mono PCM16 to 48kHz stereo PCM16 for Discord
   */
  private convertTo48kHzStereo(input: Buffer): Buffer {
    // Input: 24kHz mono PCM16 (2 bytes per sample)
    // Output: 48kHz stereo PCM16 (4 bytes per sample pair)
    const inputSamples = input.length / 2;
    const outputBuffer = Buffer.alloc(inputSamples * 8); // 2x for stereo, 2x for sample rate

    for (let i = 0; i < inputSamples; i++) {
      const sample = input.readInt16LE(i * 2);
      const outputIndex = i * 8;

      // Write each sample twice (upsample 24kHz -> 48kHz)
      // and duplicate for stereo
      outputBuffer.writeInt16LE(sample, outputIndex); // L1
      outputBuffer.writeInt16LE(sample, outputIndex + 2); // R1
      outputBuffer.writeInt16LE(sample, outputIndex + 4); // L2
      outputBuffer.writeInt16LE(sample, outputIndex + 6); // R2
    }

    return outputBuffer;
  }

  /**
   * Interrupt current playback (e.g., when user starts speaking)
   */
  private interruptPlayback(): void {
    this.audioQueue = [];
    if (this.isPlaying) {
      this.audioPlayer.stop();
      this.isPlaying = false;
    }

    // Tell the API to cancel current response
    this.send({
      type: 'response.cancel'
    });
  }

  /**
   * Attach to a voice connection for playback and audio receiving
   */
  attachConnection(connection: VoiceConnection): void {
    this.connection = connection;
    connection.subscribe(this.audioPlayer);
    this.startListening();
  }

  /**
   * Start listening to the user's audio from Discord
   */
  private startListening(): void {
    if (!this.connection || this.isListening) return;

    const receiver = this.connection.receiver;
    if (!receiver) {
      console.error('[RealtimeSession] Voice receiver not available');
      return;
    }

    this.isListening = true;
    console.log(`[RealtimeSession] Started listening for user ${this.userId}`);

    // Listen for when the specific user starts speaking
    receiver.speaking.on('start', (speakingUserId: string) => {
      if (speakingUserId !== this.userId) return;

      console.log(`[RealtimeSession] User ${this.userId} started speaking`);
      this.startRecording();
    });

    receiver.speaking.on('end', (speakingUserId: string) => {
      if (speakingUserId !== this.userId) return;

      console.log(`[RealtimeSession] User ${this.userId} stopped speaking`);
      // Audio stream will end automatically due to EndBehaviorType.AfterSilence
    });
  }

  /**
   * Start recording audio from the user
   */
  private startRecording(): void {
    if (!this.connection) return;

    try {
      // Subscribe to the user's audio - Discord sends Opus-encoded audio at 48kHz stereo
      const audioStream = this.connection.receiver.subscribe(this.userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 500 // 500ms of silence to end
        }
      });
      this.currentAudioStream = audioStream;

      // Create Opus decoder - Discord sends 48kHz stereo Opus
      // OpusEncoder has both encode() and decode() methods
      this.opusDecoder = new OpusEncoder(48000, 2);

      audioStream.on('data', (opusPacket: Buffer) => {
        try {
          if (!this.opusDecoder) return;

          // Decode Opus to PCM
          const pcmData = this.opusDecoder.decode(opusPacket);
          if (pcmData && pcmData.length > 0) {
            // Convert from 48kHz stereo to 24kHz mono for OpenAI
            const convertedData = this.convertTo24kHzMono(Buffer.from(pcmData.buffer));
            if (convertedData && convertedData.length > 0) {
              this.sendAudio(convertedData);
            }
          }
        } catch (error) {
          // Silently ignore decode errors for malformed packets
          if (process.env.DEBUG_VOICE) {
            console.error('[RealtimeSession] Error decoding opus packet:', error);
          }
        }
      });

      audioStream.on('end', () => {
        console.log(`[RealtimeSession] Audio stream ended for user ${this.userId}`);
      });

      audioStream.on('error', (error: Error) => {
        console.error('[RealtimeSession] Audio stream error:', error);
      });
    } catch (error) {
      console.error('[RealtimeSession] Error setting up audio recording:', error);
    }
  }

  /**
   * Convert 48kHz stereo PCM16 to 24kHz mono PCM16 for OpenAI
   */
  private convertTo24kHzMono(input: Buffer): Buffer {
    // Input: 48kHz stereo PCM16 (4 bytes per sample pair)
    // Output: 24kHz mono PCM16 (2 bytes per sample)
    const inputSamples = input.length / 4; // stereo pairs
    const outputSamples = Math.floor(inputSamples / 2); // downsample 48kHz -> 24kHz
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
      // Take every other sample (downsample)
      // Average left and right channels (stereo to mono)
      const inputIndex = i * 8; // 2 samples * 4 bytes per stereo pair
      const left = input.readInt16LE(inputIndex);
      const right = input.readInt16LE(inputIndex + 2);
      const mono = Math.round((left + right) / 2);
      outputBuffer.writeInt16LE(mono, i * 2);
    }

    return outputBuffer;
  }

  /**
   * Stop listening to user audio
   */
  private stopListening(): void {
    this.isListening = false;
    if (this.currentAudioStream) {
      this.currentAudioStream.destroy();
      this.currentAudioStream = null;
    }
    if (this.opusDecoder) {
      // OpusEncoder is automatically garbage collected, no explicit cleanup needed
      this.opusDecoder = null;
    }
  }

  /**
   * Disconnect from the API
   */
  async disconnect(): Promise<void> {
    this.stopListening();
    this.audioQueue = [];
    this.audioPlayer.stop();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Check if the session is connected
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get the user ID associated with this session
   */
  getUserId(): string {
    return this.userId;
  }
}
