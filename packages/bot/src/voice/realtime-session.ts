import WebSocket from 'ws';
import type { SessionUpdateEvent } from 'openai/resources/realtime/realtime';
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  EndBehaviorType
} from '@discordjs/voice';
import type { VoiceConnection } from '@discordjs/voice';
import { Readable } from 'stream';
import { randomUUID } from 'node:crypto';
import { OpusEncoder } from 'mediaplex';
import { logger } from '@silo/core';
import { buildPromptSafetyWarningMessage, evaluatePromptSafety } from '../security/prompt-safety';

import { evaluateSafetyDecision } from '../security/safety-decision';
import { resolveManagedGuildPersonaPolicy } from '../security/guild-persona-policy';
import { composeSystemPromptWithSafety } from '../security/safety-policy';
import { VoiceOutputGate } from './output-gate';
import { withLangfuseRootTrace, type TraceMetadata } from '../telemetry/langfuse-client';

const REALTIME_API_URL = 'wss://api.openai.com/v1/realtime';
const INPUT_SILENCE_MS = 500;

interface RealtimeSessionOptions {
  guildId?: string;
  onAudioResponse?: (audio: Buffer) => void;
  onTranscript?: (text: string, isFinal: boolean) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  voice?: string;
  instructions?: string;
  assistantSafetyPolicy?: 'standard' | 'contextual_banter';
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
  private startTime: number | null = null;
  private outputGate: VoiceOutputGate;
  private turnVersion = 0;
  private pendingResponseToken: string | null = null;
  private latestInputItemId: string | null = null;
  private lastTranscriptItemId: string | null = null;
  private playbackItem: { id: string; startedAt: number; durationMs: number } | null = null;
  private approvedAudioDurationMs = 0;
  private lastResponseId: string | null = null;
  private lastCompletedResponseId: string | null = null;
  private speakingStart?: (id: string) => void;
  private speakingEnd?: (id: string) => void;
  private readonly voiceTraceId = randomUUID();

  constructor(apiKey: string, userId: string, options: RealtimeSessionOptions = {}) {
    this.apiKey = apiKey;
    this.userId = userId;
    this.options = {
      voice: 'alloy',
      instructions:
        'You are a helpful AI assistant in a Discord voice channel. Keep responses concise and conversational.',
      ...options
    };

    this.outputGate = new VoiceOutputGate(
      async transcript => {
        const decision = await evaluateSafetyDecision(transcript, {
          stage: 'assistant_output',
          source: 'voice_output',
          guildId: this.options.guildId,
          userId: this.userId,
          failurePolicy: 'fail_closed',
          assistantSafetyPolicy: this.options.assistantSafetyPolicy
        });
        return decision.action === 'allow' && !decision.failed;
      },
      (audio, transcript) => {
        this.approvedAudioDurationMs = audio.length / 48;
        this.queueAudio(audio);
        this.options.onAudioResponse?.(audio);
        this.options.onTranscript?.(transcript, true);
      }
    );
    this.setupAudioPlayer();
  }

  /**
   * Setup the audio player for playing responses
   */
  private setupAudioPlayer(): void {
    this.audioPlayer.on(AudioPlayerStatus.Playing, () => this.traceStage('playback_started'));
    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      this.isPlaying = false;
      this.playNextInQueue();
    });

    this.audioPlayer.on('error', (error: Error) => {
      logger.error('[RealtimeSession] Audio player error:', error);
      this.isPlaying = false;
      this.playNextInQueue();
    });
  }

  private traceStage(stage: string, metadata: TraceMetadata = {}): void {
    void withLangfuseRootTrace(
      {
        name: 'discord.voice',
        sessionId: this.voiceTraceId,
        metadata: { stage, turn: this.turnVersion, ...metadata }
      },
      async () => {}
    ).catch(error => logger.warn('[RealtimeSession] Voice timing trace failed', error));
  }

  /**
   * Connect to the OpenAI Realtime API
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
        `${REALTIME_API_URL}?model=${encodeURIComponent(process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime')}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`
          }
        }
      );

      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.ws?.close();
      }, 30000);

      this.ws.on('open', () => {
        this.startTime = Date.now();
        this.configureSession();
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const event = JSON.parse(data.toString());
          if (event.type === 'session.updated') {
            clearTimeout(timeout);
            resolve();
          }
          if (event.type === 'error') {
            clearTimeout(timeout);
            reject(new Error('Voice session configuration failed'));
          }
        } catch {
          /* The event handler rejects malformed input separately. */
        }
        this.handleMessage(data);
      });

      this.ws.on('error', (error: Error) => {
        clearTimeout(timeout);
        logger.error('[RealtimeSession] WebSocket error:', error);
        this.options.onError?.(error);
        reject(error);
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        this.outputGate.cancel();
        this.stopListening();
        this.audioPlayer.stop();
        reject(new Error('Voice connection closed before readiness'));
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
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: this.options.instructions,
        max_output_tokens: 1024,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: INPUT_SILENCE_MS,
              create_response: false,
              interrupt_response: false
            }
          },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this.options.voice }
        }
      }
    } satisfies SessionUpdateEvent);
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

        case 'response.created':
          if (message.response?.id === this.lastResponseId) break;
          this.lastResponseId = message.response?.id || null;
          if (
            !this.pendingResponseToken ||
            message.response?.metadata?.turn_id !== this.pendingResponseToken
          ) {
            this.send({ type: 'response.cancel', response_id: message.response?.id });
          } else {
            this.outputGate.start(message.response.id);
          }
          break;

        case 'response.output_audio.delta':
          if (message.delta)
            this.outputGate.append(message.response_id, Buffer.from(message.delta, 'base64'));
          break;

        case 'response.done':
          this.finishVoiceResponse(message.response).catch(error =>
            this.handleVoiceSafetyError('Voice output failed', error)
          );
          break;

        case 'input_audio_buffer.speech_started':
          this.traceStage('speech_started');
          // User started speaking - interrupt any playing audio
          this.interruptPlayback();
          this.latestInputItemId = message.item_id || null;
          break;

        case 'input_audio_buffer.speech_stopped':
          this.traceStage('speech_stopped');
          break;

        case 'conversation.item.input_audio_transcription.completed':
          this.traceStage('transcription_completed', {
            characters: String(message.transcript || '').length
          });
          // Transcription of user's speech is complete
          logger.debug('[RealtimeSession] User transcript received', {
            characters: String(message.transcript || '').length
          });
          if (message.transcript) {
            this.handleVoiceTranscript(message.transcript, message.item_id).catch(error => {
              this.handleVoiceSafetyError('Failed to handle voice transcript', error);
            });
          }
          break;

        case 'error': {
          // Ignore non-critical errors
          const errorCode = message.error?.code;
          if (errorCode === 'response_cancel_not_active') {
            // This just means we tried to cancel when no response was active - not an error
            break;
          }
          logger.error('[RealtimeSession] API error:', message.error);
          this.options.onError?.(new Error(message.error?.message || 'Unknown error'));
          break;
        }

        default:
          // Log unknown message types for debugging
          if (process.env.DEBUG_VOICE) {
            logger.debug('[RealtimeSession] Unknown message type:', message.type);
          }
      }
    } catch (error) {
      logger.error('[RealtimeSession] Error parsing message:', error);
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
    this.sendTextGuarded(text).catch(error => {
      this.handleVoiceSafetyError('Failed to send guarded voice text', error);
    });
  }

  /**
   * Send a greeting message that the AI will speak aloud
   * Used when the bot first joins a voice channel
   */
  sendGreeting(greeting?: string): void {
    this.sendText(
      greeting ||
        'Introduce yourself briefly and explain that you can answer questions. Keep it under 15 seconds.'
    );
  }

  private requestResponse(): void {
    this.pendingResponseToken = String(++this.turnVersion);
    this.traceStage('response_requested');
    this.send({
      type: 'response.create',
      response: { metadata: { turn_id: this.pendingResponseToken } }
    });
  }

  private async finishVoiceResponse(response: {
    id?: string;
    status?: string;
    output?: Array<{ id?: string; type?: string; content?: Array<{ transcript?: string }> }>;
  }): Promise<void> {
    if (!response.id || response.id === this.lastCompletedResponseId) return;
    this.lastCompletedResponseId = response.id;
    this.traceStage('response_completed', { status: response.status ?? 'unknown' });
    const items = response.output || [];
    const transcript = items
      .flatMap(item => item.content || [])
      .map(part => part.transcript || '')
      .join(' ');
    const completed =
      response.status === 'completed' && items.every(item => item.type === 'message');
    const approved = await this.outputGate.finish(response.id, completed ? transcript : '');
    this.traceStage('output_checked', { approved });
    if (!approved) {
      for (const item of items)
        if (item.id) this.send({ type: 'conversation.item.delete', item_id: item.id });
    } else if (items[0]?.id) {
      this.playbackItem = {
        id: items[0].id,
        startedAt: Date.now(),
        durationMs: this.approvedAudioDurationMs
      };
    }
  }

  private async sendTextGuarded(text: string): Promise<void> {
    this.interruptPlayback();
    const version = this.turnVersion;
    let safetyResult;

    try {
      safetyResult = await evaluatePromptSafety(text, {
        profile: 'strict_tool_input',
        source: 'voice_text',
        guildId: this.options.guildId,
        userId: this.userId
      });
    } catch (error) {
      if (version === this.turnVersion)
        this.handleVoiceSafetyError('Voice text guardrail evaluation failed', error);
      return;
    }

    if (version !== this.turnVersion || !this.isConnected()) return;
    if (!safetyResult.allowed) {
      this.emitVoiceSafetyFallback(safetyResult.reasons, safetyResult.moderationCategories);
      return;
    }

    this.refreshManagedInstructions(safetyResult.safeguardsEnabled !== false);

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

    this.requestResponse();
  }

  private async handleVoiceTranscript(transcript: string, itemId: string): Promise<void> {
    if (!itemId || itemId !== this.latestInputItemId || itemId === this.lastTranscriptItemId)
      return;
    this.lastTranscriptItemId = itemId;
    const version = this.turnVersion;
    let safetyResult;

    try {
      safetyResult = await evaluatePromptSafety(transcript, {
        profile: 'strict_tool_input',
        source: 'voice_transcript',
        guildId: this.options.guildId,
        userId: this.userId
      });
    } catch (error) {
      this.send({ type: 'conversation.item.delete', item_id: itemId });
      if (version === this.turnVersion)
        this.handleVoiceSafetyError('Voice transcript guardrail evaluation failed', error);
      return;
    }

    if (version !== this.turnVersion || !this.isConnected()) {
      this.send({ type: 'conversation.item.delete', item_id: itemId });
      return;
    }
    if (safetyResult.allowed) {
      this.refreshManagedInstructions(safetyResult.safeguardsEnabled !== false);
      this.requestResponse();
      return;
    }

    this.send({ type: 'conversation.item.delete', item_id: itemId });
    logger.warn('[RealtimeSession] Blocked unsafe voice transcript', {
      userId: this.userId,
      reasons: safetyResult.reasons,
      moderationCategories: safetyResult.moderationCategories
    });

    this.emitVoiceSafetyFallback(safetyResult.reasons, safetyResult.moderationCategories);
  }

  private refreshManagedInstructions(safeguardsEnabled: boolean): void {
    const policy = resolveManagedGuildPersonaPolicy(this.options.guildId);
    if (!policy) return;
    const instructions = composeSystemPromptWithSafety(
      safeguardsEnabled ? policy.prompt : policy.promptWithoutContentSafeguards || policy.prompt,
      safeguardsEnabled
    );
    const update: SessionUpdateEvent = {
      type: 'session.update',
      session: { type: 'realtime', instructions }
    };
    this.send({ ...update });
  }

  private handleVoiceSafetyError(context: string, error: unknown): void {
    logger.error(`[RealtimeSession] ${context}`, {
      userId: this.userId,
      error
    });
    this.emitVoiceSafetyFallback([], []);
  }

  private emitVoiceSafetyFallback(reasons: string[], moderationCategories: string[]): void {
    const warning = buildPromptSafetyWarningMessage({
      profile: 'strict_tool_input',
      reasons,
      moderationCategories
    }).replace(/^⚠️\s*/, '');

    this.interruptPlayback();
    this.send({
      type: 'response.cancel'
    });
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `Respond briefly in voice. State that you can't help with that request, use this explanation if helpful: ${warning} Do not repeat the unsafe content. Offer one safer alternative in the same response.`
          }
        ]
      }
    });
    this.requestResponse();
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
    this.turnVersion++;
    this.pendingResponseToken = null;
    this.outputGate.cancel();
    if (this.playbackItem && this.isPlaying) {
      this.send({
        type: 'conversation.item.truncate',
        item_id: this.playbackItem.id,
        content_index: 0,
        audio_end_ms: Math.min(
          this.playbackItem.durationMs,
          Math.max(0, Date.now() - this.playbackItem.startedAt)
        )
      });
    }
    this.playbackItem = null;
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
      logger.error('[RealtimeSession] Voice receiver not available');
      return;
    }

    this.isListening = true;
    logger.info(`[RealtimeSession] Started listening for user ${this.userId}`);

    // Listen for when the specific user starts speaking
    this.speakingStart = (speakingUserId: string) => {
      if (speakingUserId !== this.userId) return;

      logger.debug(`[RealtimeSession] User ${this.userId} started speaking`);
      this.startRecording();
    };
    receiver.speaking.on('start', this.speakingStart);

    this.speakingEnd = (speakingUserId: string) => {
      if (speakingUserId !== this.userId) return;

      logger.debug(`[RealtimeSession] User ${this.userId} stopped speaking`);
      // Audio stream ends automatically after silence.
    };
    receiver.speaking.on('end', this.speakingEnd);
    this.traceStage('listening_started');
    if (receiver.speaking.users.has(this.userId)) this.startRecording();
  }

  /**
   * Start recording audio from the user
   */
  private startRecording(): void {
    if (!this.connection || (this.currentAudioStream && !this.currentAudioStream.destroyed)) return;

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
      const decoder = new OpusEncoder(48000, 2);
      let capturedBytes = 0;
      const captureStartedAt = Date.now();

      audioStream.on('data', (opusPacket: Buffer) => {
        try {
          if (this.currentAudioStream !== audioStream) return;

          // Decode Opus to PCM
          const pcmData = decoder.decode(opusPacket);
          if (pcmData && pcmData.length > 0) {
            // Convert from 48kHz stereo to 24kHz mono for OpenAI
            const convertedData = this.convertTo24kHzMono(Buffer.from(pcmData));
            if (convertedData && convertedData.length > 0) {
              if (capturedBytes === 0) this.traceStage('audio_received');
              capturedBytes += convertedData.length;
              this.sendAudio(convertedData);
            }
          }
        } catch (error) {
          // Silently ignore decode errors for malformed packets
          if (process.env.DEBUG_VOICE) {
            logger.error('[RealtimeSession] Error decoding opus packet:', error);
          }
        }
      });

      audioStream.on('end', () => {
        if (this.currentAudioStream !== audioStream) return;
        this.currentAudioStream = null;
        // Discord stops delivering packets during pauses. Feed the provider a
        // bounded silence tail so server VAD can commit without another utterance.
        // Do not also commit manually: server VAD owns the input item boundary.
        if (capturedBytes > 0 && this.isConnected()) {
          this.sendAudio(Buffer.alloc(48 * (INPUT_SILENCE_MS + 100)));
        }
        this.traceStage('capture_ended', {
          audioMs: capturedBytes / 48,
          elapsedMs: Date.now() - captureStartedAt
        });
        logger.debug(`[RealtimeSession] Audio stream ended for user ${this.userId}`);
      });

      audioStream.on('close', () => {
        if (this.currentAudioStream !== audioStream) return;
        this.currentAudioStream = null;
      });

      audioStream.on('error', (error: Error) => {
        this.traceStage('capture_error');
        logger.error('[RealtimeSession] Audio stream error:', error);
      });
    } catch (error) {
      logger.error('[RealtimeSession] Error setting up audio recording:', error);
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
    if (this.speakingStart) this.connection?.receiver.speaking.off('start', this.speakingStart);
    if (this.speakingEnd) this.connection?.receiver.speaking.off('end', this.speakingEnd);
    this.speakingStart = undefined;
    this.speakingEnd = undefined;
    if (this.currentAudioStream) {
      this.currentAudioStream.destroy();
      this.currentAudioStream = null;
    }
  }

  /**
   * Disconnect from the API and return session duration in milliseconds
   */
  async disconnect(): Promise<number> {
    this.traceStage('disconnected');
    this.interruptPlayback();
    this.stopListening();
    this.audioQueue = [];
    this.audioPlayer.stop();

    const durationMs = this.startTime ? Date.now() - this.startTime : 0;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    return durationMs;
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
