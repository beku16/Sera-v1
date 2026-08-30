import { arrayBufferToBase64, calculateRms, float32ToInt16Pcm } from './audioUtils';
import { AudioDiagnosticsTracker } from './AudioDiagnostics';
import { AudioResampler } from './resampler';
import { VoiceActivityDetector, VadResult } from './VoiceActivityDetector';
import { WakeWordDetectionResult, WakeWordDetector } from './WakeWordDetector';
import { AudioDiagnosticsInfo } from '../types';

export interface AudioStreamerConfig {
  sampleRate?: number; // Target sample rate, default 16000
  bufferSize?: number; // Processing buffer size, default 2048
  gain?: number;       // Input gain multiplier, default 1.0
  deviceId?: string;   // Specific microphone device ID
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  startAttemptId?: string; // Tracing ID for this start attempt
  enableWakeWord?: boolean;
  onAudioChunk?: (base64Chunk: string, rawPcm: Int16Array) => void;
  onSpeakerFrame?: (rawPcm: Int16Array, isSpeech: boolean) => void;
  onVolumeChange?: (volume: number) => void;
  onVadUpdate?: (vadResult: VadResult) => void;
  onWakeWordDetected?: (result: WakeWordDetectionResult) => void;
  onDiagnostics?: (info: AudioDiagnosticsInfo) => void;
  onError?: (error: Error) => void;
}

export class AudioStreamer {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private highPassFilter: BiquadFilterNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private gainNode: GainNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private resampler: AudioResampler | null = null;
  private vad: VoiceActivityDetector;
  private wakeWordDetector: WakeWordDetector;
  private diagnostics: AudioDiagnosticsTracker;

  private config: AudioStreamerConfig;
  private isStreaming: boolean = false;
  private wakeWordActivated: boolean = false;
  private targetSampleRate: number = 16000;
  private startAttemptId: string = '';

  constructor(config: AudioStreamerConfig = {}) {
    this.config = {
      sampleRate: 16000,
      bufferSize: 2048,
      gain: 1.0,
      ...config,
    };
    this.startAttemptId = config.startAttemptId || `audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.targetSampleRate = this.config.sampleRate || 16000;
    this.vad = new VoiceActivityDetector(this.targetSampleRate);
    this.wakeWordDetector = new WakeWordDetector();
    this.wakeWordDetector.setListener((result) => {
      this.wakeWordActivated = true;
      if (this.config.onWakeWordDetected) {
        try {
          this.config.onWakeWordDetected(result);
        } catch (err) {
          console.warn('[SERA] wake-word callback error:', err);
        }
      }
      console.log(`[SERA] ${this.startAttemptId} 🔔 Wake word detected: ${result.confidence.toFixed(2)}`);
    });
    this.diagnostics = new AudioDiagnosticsTracker();
  }

  /**
   * Starts capturing microphone audio with hardware DSP filtering and real-time noise suppression
   */
  public async start(): Promise<void> {
    console.log(`[SERA] ${this.startAttemptId} AudioStreamer.start() called`);
    if (this.isStreaming) {
      console.log(`[SERA] ${this.startAttemptId} AudioStreamer already streaming, skipping`);
      return;
    }

    try {
      // 1. Request microphone access with progressive constraint negotiation
      console.log(`[SERA] ${this.startAttemptId}   STEP A: Requesting getUserMedia permission`);
      let stream: MediaStream;
      const enableEcho = this.config.echoCancellation ?? true;
      const enableNoise = this.config.noiseSuppression ?? true;
      const enableAgc = this.config.autoGainControl ?? true;
      let usedConstraints = { echoCancellation: enableEcho, autoGainControl: enableAgc };

      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: enableEcho,
        noiseSuppression: enableNoise,
        autoGainControl: enableAgc,
      };

      if (this.config.deviceId && this.config.deviceId !== 'default') {
        audioConstraints.deviceId = { exact: this.config.deviceId };
      }

      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
        console.log(`[SERA] ${this.startAttemptId}   ✓ STEP A COMPLETE: Microphone permission granted (device: ${this.config.deviceId || 'default'})`);
      } catch (constraintErr) {
        console.warn(`[SERA] ${this.startAttemptId}   Advanced constraints failed:`, constraintErr);
        console.log(`[SERA] ${this.startAttemptId}   STEP A RETRY: Requesting basic getUserMedia`);
        usedConstraints = { echoCancellation: false, autoGainControl: false };
        const fallbackConstraints: MediaTrackConstraints = {};
        if (this.config.deviceId && this.config.deviceId !== 'default') {
          fallbackConstraints.deviceId = { ideal: this.config.deviceId };
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: Object.keys(fallbackConstraints).length > 0 ? fallbackConstraints : true });
        console.log(`[SERA] ${this.startAttemptId}   ✓ STEP A COMPLETE: Microphone permission granted (basic fallback)`);
      }

      this.mediaStream = stream;
      this.diagnostics.updateConstraints(usedConstraints);

      // 2. Initialize AudioContext
      console.log(`[SERA] ${this.startAttemptId}   STEP B: Initializing AudioContext`);
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioCtxClass();

      if (this.audioContext.state === 'suspended') {
        console.log(`[SERA] ${this.startAttemptId}   AudioContext suspended, resuming...`);
        await this.audioContext.resume();
      }

      const nativeSampleRate = this.audioContext.sampleRate;
      this.resampler = new AudioResampler(nativeSampleRate, this.targetSampleRate);
      this.diagnostics.updateContext(this.audioContext.state, nativeSampleRate);
      console.log(`[SERA] ${this.startAttemptId}   ✓ STEP B COMPLETE: AudioContext ready (native: ${nativeSampleRate}Hz, target: ${this.targetSampleRate}Hz)`);

      // 3. Construct Hardware Web Audio DSP Graph:
      // Source -> HighPassFilter (85Hz) -> DynamicsCompressor -> GainNode -> Analyser -> ScriptProcessor -> Destination

      console.log(`[SERA] ${this.startAttemptId}   STEP C: Building DSP audio graph`);
      
      // 3a. MediaStream source
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      console.log(`[SERA] ${this.startAttemptId}     [1/6] MediaStreamSource created`);

      // 3b. High-pass filter (85 Hz, Q=0.707) removes AC hum, sub-rumble, and mic thumps
      this.highPassFilter = this.audioContext.createBiquadFilter();
      this.highPassFilter.type = 'highpass';
      this.highPassFilter.frequency.value = 85;
      this.highPassFilter.Q.value = 0.707;
      console.log(`[SERA] ${this.startAttemptId}     [2/6] HighPassFilter created`);

      // 3c. Dynamics Compressor (soft knee, prevents mic clipping and boosts quiet speech naturally)
      this.compressorNode = this.audioContext.createDynamicsCompressor();
      this.compressorNode.threshold.value = -24; // dB
      this.compressorNode.knee.value = 30;       // dB
      this.compressorNode.ratio.value = 3.5;
      this.compressorNode.attack.value = 0.003;  // 3ms fast attack
      this.compressorNode.release.value = 0.20;  // 200ms release
      console.log(`[SERA] ${this.startAttemptId}     [3/6] DynamicsCompressor created`);

      // 3d. User Input Gain Node
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.config.gain ?? 1.0;
      console.log(`[SERA] ${this.startAttemptId}     [4/6] GainNode created`);

      // 3e. Spectrum Analyser Node
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;
      console.log(`[SERA] ${this.startAttemptId}     [5/6] AnalyserNode created`);

      // 3f. Audio Processing Block
      const bufferSize = this.config.bufferSize || 2048;
      this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
      console.log(`[SERA] ${this.startAttemptId}     [6/6] ScriptProcessor created (buffer: ${bufferSize})`);

      let audioFrameCount = 0;
      this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        try {
          if (!this.isStreaming) return;
          
          audioFrameCount++;
          if (audioFrameCount === 1) {
            console.log(`[SERA] ${this.startAttemptId} ✓ STEP C COMPLETE: First audio frame received - DSP pipeline ACTIVE`);
          }
          
          const startTime = performance.now();

          const inputData = event.inputBuffer.getChannelData(0);

          // 1. Raw volume calculation
          const volume = calculateRms(inputData);
          if (this.config.onVolumeChange) {
            this.config.onVolumeChange(volume);
          }

          // 2. Resample native rate to 16kHz
          let samples16k: Float32Array;
          if (this.resampler) {
            samples16k = this.resampler.resample(inputData);
          } else {
            samples16k = inputData;
          }

          // 3. Real-Time Multi-Feature VAD Detection
          const vadResult = this.vad.process(samples16k);
          if (this.config.onVadUpdate) {
            try {
              this.config.onVadUpdate(vadResult);
            } catch (err) {
              console.warn('[SERA] onVadUpdate callback error:', err);
            }
          }
          
          // 4. Convert the resampled microphone signal directly to PCM16.
          const pcm16 = float32ToInt16Pcm(samples16k);

          if (this.config.onSpeakerFrame) {
            try {
              this.config.onSpeakerFrame(pcm16, vadResult.isSpeech);
            } catch (err) {
              console.error('[SERA] onSpeakerFrame callback error:', err);
            }
          }

          if (this.config.enableWakeWord) {
            const wakeResult = this.wakeWordDetector.process(samples16k);
            if (wakeResult.detected) {
              console.log(`[SERA] ${this.startAttemptId} 🟢 WAKE WORD DETECTED: ${wakeResult.confidence.toFixed(2)}`);
            }
          }

          const shouldForwardAudio = !this.config.enableWakeWord || this.wakeWordActivated;
          if (shouldForwardAudio) {
            // 6. Base64 encode for Gemini Live API
            const base64Chunk = arrayBufferToBase64(pcm16.buffer);
            if (this.config.onAudioChunk) {
              try {
                this.config.onAudioChunk(base64Chunk, pcm16);
              } catch (err) {
                console.error('[SERA] onAudioChunk callback error:', err);
              }
            }
          }

          const processingDuration = performance.now() - startTime;

          // 7. Update diagnostics snapshot
          const inputRmsDb = Math.round(20 * Math.log10(Math.max(1e-4, volume)) * 10) / 10;
          this.diagnostics.updateMetrics({
            noiseFloorDb: vadResult.noiseFloorDb,
            inputRmsDb,
            snrDb: vadResult.snrDb,
            isSpeechDetected: vadResult.isSpeech,
            speechProbability: vadResult.speechProbability,
            processingLatencyMs: processingDuration,
          });

          if (this.config.onDiagnostics) {
            try {
              this.config.onDiagnostics(this.diagnostics.getSnapshot());
            } catch (err) {
              console.warn('[SERA] onDiagnostics callback error:', err);
            }
          }
        } catch (err) {
          console.error(`[SERA] ${this.startAttemptId} ❌ CRITICAL audio processing error (this will stop the stream):`, err);
          this.stop();
          if (this.config.onError) {
            this.config.onError(err instanceof Error ? err : new Error(String(err)));
          }
        }
      };

      // Connect DSP Graph
      console.log(`[SERA] ${this.startAttemptId}   STEP D: Connecting DSP graph nodes`);
      this.sourceNode.connect(this.highPassFilter);
      console.log(`[SERA] ${this.startAttemptId}     [1/5] HighPassFilter connected`);
      this.highPassFilter.connect(this.compressorNode);
      console.log(`[SERA] ${this.startAttemptId}     [2/5] DynamicsCompressor connected`);
      this.compressorNode.connect(this.gainNode);
      console.log(`[SERA] ${this.startAttemptId}     [3/5] GainNode connected`);
      this.gainNode.connect(this.analyserNode);
      console.log(`[SERA] ${this.startAttemptId}     [4/5] AnalyserNode connected`);
      this.gainNode.connect(this.processorNode);
      console.log(`[SERA] ${this.startAttemptId}     [5/5] ScriptProcessor connected`);

      // 3e. Silent sink node — keeps ScriptProcessor firing in Web Audio with ZERO audio leaking into speakers
      const silentMuteNode = this.audioContext.createGain();
      silentMuteNode.gain.setValueAtTime(0, this.audioContext.currentTime);
      this.processorNode.connect(silentMuteNode);
      silentMuteNode.connect(this.audioContext.destination);
      console.log(`[SERA] ${this.startAttemptId}   ✓ STEP D COMPLETE: DSP graph connected to isolated silent destination`);

      this.isStreaming = true;
      this.diagnostics.updateStreaming(true);
      console.log(`[SERA] ${this.startAttemptId} ✓ AudioStreamer FULLY INITIALIZED - Ready for audio`);
    } catch (err) {
      console.error(`[SERA] ${this.startAttemptId} ❌ AudioStreamer initialization FAILED:`, err);
      this.stop();
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.config.onError) {
        this.config.onError(error);
      }
      throw error;
    }
  }

  /**
   * Resumes the capture context after browser suspension.
   */
  public async resume(): Promise<void> {
    const contextState = this.audioContext?.state;
    const shouldRestart = this.isStreaming && contextState === 'closed';
    if (shouldRestart) {
      this.stop();
      await this.start();
      return;
    }
    if (contextState === 'suspended') await this.audioContext?.resume();
    if (this.audioContext) this.diagnostics.updateContext(this.audioContext.state, this.audioContext.sampleRate);
  }

  /**
   * Sets the input gain
   */
  public setGain(value: number): void {
    this.config.gain = value;
    if (this.gainNode) {
      this.gainNode.gain.value = value;
    }
  }

  public getContextState(): AudioContextState | 'uninitialized' {
    return this.audioContext?.state || 'uninitialized';
  }

  /**
   * Returns latest audio diagnostics snapshot
   */
  public getDiagnostics(): AudioDiagnosticsInfo {
    return this.diagnostics.getSnapshot();
  }

  /**
   * Returns frequency data from the AnalyserNode for visualizers
   */
  public getFrequencyData(outputArray: Uint8Array): void {
    if (this.analyserNode && this.isStreaming) {
      this.analyserNode.getByteFrequencyData(outputArray);
    } else {
      outputArray.fill(0);
    }
  }

  /**
   * Stops streaming and cleanly releases all hardware and context resources
   */
  public stop(): void {
    this.isStreaming = false;
    this.diagnostics.updateStreaming(false);

    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.highPassFilter) {
      this.highPassFilter.disconnect();
      this.highPassFilter = null;
    }

    if (this.compressorNode) {
      this.compressorNode.disconnect();
      this.compressorNode = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.resampler = null;
    this.vad.reset();
    this.wakeWordDetector.reset();
    this.wakeWordActivated = false;
  }

  public getStreamingStatus(): boolean {
    return this.isStreaming;
  }
}



