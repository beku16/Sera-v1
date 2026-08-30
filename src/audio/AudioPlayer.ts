import { base64PcmToFloat32, calculateRms } from './audioUtils';
import { AudioResampler } from './resampler';

export interface AudioPlayerConfig {
  sampleRate?: number; // Source PCM sample rate (Gemini Live = 24000Hz)
  volume?: number;     // Master volume (0.0 to 1.0)
  outputDeviceId?: string; // Specific speaker/headphone device ID
  onPlaybackStart?: () => void;
  onPlaybackEnd?: () => void;
  onVolumeChange?: (volume: number) => void;
  onError?: (error: Error) => void;
}

/**
 * Continuous PCM FIFO Audio Player for Gemini Live.
 *
 * Architecture:
 *  - Uses a single continuous Web Audio stream powered by a sample FIFO ring queue.
 *  - Eliminates creating 20-50 discrete AudioBufferSourceNodes per second.
 *  - Completely eliminates node start/stop quantum boundary micro-clicks ("peee / ceeee").
 *  - Resamples 24kHz Gemini Live audio to system DAC rate (48kHz) phase-continuously.
 *  - Instant zero-latency interruption (barge-in).
 */
export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private resampler: AudioResampler | null = null;

  // Continuous sample FIFO queue (Float32 samples at audioContext.sampleRate)
  private queue: Float32Array[] = [];
  private currentChunk: Float32Array | null = null;
  private currentOffset: number = 0;
  private queuedSampleCount: number = 0;

  private isPlaying: boolean = false;
  private config: AudioPlayerConfig;
  private sourceSampleRate: number = 24000;
  private endTimeout: number | null = null;
  private playbackGeneration: number = 0;

  constructor(config: AudioPlayerConfig = {}) {
    this.config = {
      sampleRate: 24000,
      volume: 1.0,
      outputDeviceId: 'default',
      ...config,
    };
    this.sourceSampleRate = this.config.sampleRate || 24000;
  }

  /** Eagerly prepares and resumes the AudioContext on user gesture */
  public async init(): Promise<void> {
    await this.ensureAudioContext();
  }

  /** Dynamically sets the audio output device (speaker/headphones) */
  public async setOutputDevice(deviceId: string): Promise<void> {
    this.config.outputDeviceId = deviceId;
    if (this.audioContext && 'setSinkId' in this.audioContext) {
      try {
        await (this.audioContext as any).setSinkId(deviceId === 'default' ? '' : deviceId);
        console.log(`[AudioPlayer] Output device switched to: ${deviceId}`);
      } catch (err) {
        console.warn(`[AudioPlayer] Failed to set sinkId:`, err);
      }
    }
  }

  /**
   * Initializes the continuous AudioContext and continuous FIFO pump
   */
  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      // Run AudioContext at hardware DAC native rate (48kHz/44.1kHz) to prevent OS-level distortion
      this.audioContext = new AudioCtxClass();

      // Phase-continuous resampler from Gemini (24kHz) to Hardware (e.g. 48kHz)
      this.resampler = new AudioResampler(this.sourceSampleRate, this.audioContext.sampleRate);

      if (
        this.config.outputDeviceId &&
        this.config.outputDeviceId !== 'default' &&
        'setSinkId' in this.audioContext
      ) {
        try {
          await (this.audioContext as any).setSinkId(this.config.outputDeviceId);
        } catch (sinkErr) {
          console.warn('[AudioPlayer] Initial setSinkId failed:', sinkErr);
        }
      }

      // 1. Gain Node (Master Volume)
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.config.volume ?? 1.0;

      // 2. Analyser Node (Waveform / Spectrum Visualization)
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;

      // 3. Continuous FIFO Audio Stream Pump (bufferSize = 2048 for smooth glitch-free playback)
      this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);
      this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        const output = event.outputBuffer.getChannelData(0);
        const bufferLen = output.length;
        let written = 0;

        while (written < bufferLen) {
          if (!this.currentChunk || this.currentOffset >= this.currentChunk.length) {
            if (this.queue.length > 0) {
              this.currentChunk = this.queue.shift()!;
              this.currentOffset = 0;
            } else {
              this.currentChunk = null;
              break;
            }
          }

          const available = this.currentChunk.length - this.currentOffset;
          const needed = bufferLen - written;
          const toCopy = Math.min(available, needed);

          output.set(
            this.currentChunk.subarray(this.currentOffset, this.currentOffset + toCopy),
            written
          );
          this.currentOffset += toCopy;
          written += toCopy;
        }

        // Fill underrun / silence
        if (written < bufferLen) {
          output.subarray(written).fill(0);
        }

        // Recalculate remaining samples in FIFO
        let remaining = this.currentChunk ? this.currentChunk.length - this.currentOffset : 0;
        for (let i = 0; i < this.queue.length; i++) {
          remaining += this.queue[i].length;
        }
        this.queuedSampleCount = remaining;

        // Manage playback state transitions
        if (written > 0 && !this.isPlaying) {
          this.isPlaying = true;
          if (this.endTimeout) {
            clearTimeout(this.endTimeout);
            this.endTimeout = null;
          }
          this.config.onPlaybackStart?.();
        } else if (remaining === 0 && this.isPlaying) {
          if (!this.endTimeout) {
            this.endTimeout = window.setTimeout(() => {
              if (this.queuedSampleCount === 0 && this.isPlaying) {
                this.isPlaying = false;
                this.config.onPlaybackEnd?.();
              }
              this.endTimeout = null;
            }, 120);
          }
        }
      };

      // Connect DSP graph: Processor -> Gain -> Analyser -> Destination
      this.processorNode.connect(this.gainNode);
      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.audioContext.destination);
    }

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    return this.audioContext;
  }

  /** Plays a rich, futuristic 3-tone harmonic celestial wake chime */
  public async playWakeChime(): Promise<void> {
    try {
      const ctx = await this.ensureAudioContext();
      const now = ctx.currentTime;
      const tones: [number, number, number, number, number][] = [
        [523.25, 0, 0.03, 0.35, 0.22],
        [783.99, 0.08, 0.12, 0.48, 0.28],
        [1046.50, 0.16, 0.20, 0.65, 0.32],
      ];
      for (const [freq, start, attack, decay, peak] of tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + start);
        gain.gain.setValueAtTime(0.001, now + start);
        gain.gain.exponentialRampToValueAtTime(peak, now + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + decay + 0.05);
      }
    } catch (err) {
      console.warn('[AudioPlayer] Wake chime notice:', err);
    }
  }

  /**
   * Queues a base64-encoded PCM16 chunk directly into the continuous audio FIFO.
   */
  public async queueAudioChunk(base64PcmChunk: string): Promise<void> {
    const generation = this.playbackGeneration;
    try {
      await this.ensureAudioContext();
      if (generation !== this.playbackGeneration) return;

      // 1. Decode base64 PCM16 Little-Endian into 24kHz Float32Array
      const float32Samples24k = base64PcmToFloat32(base64PcmChunk);
      if (float32Samples24k.length === 0) return;

      // 2. Resample phase-continuously from 24kHz to hardware rate (e.g. 48kHz)
      const playbackSamples = this.resampler
        ? this.resampler.resample(float32Samples24k)
        : float32Samples24k;

      if (playbackSamples.length === 0) return;

      // 3. Push to continuous FIFO queue — bounded to prevent unbounded
      // memory growth when the producer (Gemini audio chunks at 24kHz)
      // outpaces the consumer (onaudioprocess at the hardware rate). 200
      // chunks at ~480 samples each = ~96k samples = ~2s of buffered audio
      // at 48kHz. Anything older than ~2s of audio is dropped (with a
      // console warning) because the user would notice the drift anyway.
      const MAX_QUEUE_CHUNKS = 200;
      while (this.queue.length > MAX_QUEUE_CHUNKS) {
        const dropped = this.queue.shift();
        if (dropped) this.queuedSampleCount -= dropped.length;
      }
      if (this.queue.length === MAX_QUEUE_CHUNKS) {
        // Queue is at capacity — drop the oldest chunk to make room for the
        // newest (drop-tail strategy would cause playback to freeze).
        const dropped = this.queue.shift();
        if (dropped) this.queuedSampleCount -= dropped.length;
        console.warn('[AudioPlayer] Audio queue full — dropping oldest chunk to bound memory.');
      }
      this.queue.push(playbackSamples);
      this.queuedSampleCount += playbackSamples.length;

      // 4. Update volume diagnostics
      if (this.config.onVolumeChange) {
        this.config.onVolumeChange(calculateRms(float32Samples24k));
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.config.onError?.(error);
    }
  }

  /**
   * Immediately stops all currently playing audio (Barge-in / Interruption).
   * Empties the FIFO ring buffer instantaneously.
   */
  public interrupt(): void {
    this.playbackGeneration += 1;
    this.queue = [];
    this.currentChunk = null;
    this.currentOffset = 0;
    this.queuedSampleCount = 0;
    this.resampler?.reset();

    if (this.endTimeout) {
      clearTimeout(this.endTimeout);
      this.endTimeout = null;
    }

    if (this.isPlaying) {
      this.isPlaying = false;
      this.config.onPlaybackEnd?.();
    }
  }

  public setVolume(volume: number): void {
    this.config.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode && this.audioContext) {
      this.gainNode.gain.setValueAtTime(this.config.volume, this.audioContext.currentTime);
    }
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getContextState(): AudioContextState | 'closed' {
    return this.audioContext ? this.audioContext.state : 'closed';
  }

  public getFrequencyData(array: Uint8Array): void {
    if (this.analyserNode) {
      this.analyserNode.getByteFrequencyData(array);
    } else {
      array.fill(0);
    }
  }

  public close(): void {
    this.interrupt();
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    // Disconnect the analyser and gain nodes too — previously only the
    // processor node was disconnected, leaving the analyser/gain chain
    // attached to the destination. Closing the AudioContext will free the
    // native resources, but disconnecting first avoids the "still-connected
    // during close" warning some browsers log.
    if (this.analyserNode) {
      try { this.analyserNode.disconnect(); } catch {}
      this.analyserNode = null;
    }
    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch {}
      this.gainNode = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }
}
