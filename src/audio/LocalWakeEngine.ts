/**
 * LocalWakeEngine — Immortal, High-Sensitivity Local Wake Word Engine
 *
 * Designed for continuous hands-free operation in Chrome, Edge, Safari, and Electron.
 *
 * Architectural Features:
 * 1. Immortal Continuous Loop: Whenever Chrome ends recognition (silence timeout),
 *    it automatically and cleanly restarts after a brief 100ms pause. It NEVER shuts down
 *    unless explicitly stopped.
 * 2. Instant Syllable Evaluation: `interimResults = true` processes every syllable in real time.
 * 3. 5 N-Best Hypotheses: Evaluates all alternatives for maximum phonetic recognition.
 * 4. Locale Adaptive: Uses `navigator.language` (e.g. en-IN, en-US, en-GB) for optimal accent recognition.
 * 5. Rolling Deduplicated Window: Catches split phrases ("Hey" ... pause ... "Sera").
 * 6. Non-destructive Lifecycle: Clean handover to LiveSession when wake is detected.
 */

import { evaluateWakePhrase, extractWakePrompt, normalize } from './wakePhrase';

export type LocalWakeLifecycleState =
  | 'IDLE'
  | 'STARTING'
  | 'LISTENING'
  | 'WAKE_DETECTED'
  | 'COMMAND_LISTENING'
  | 'PROCESSING'
  | 'STOPPING'
  | 'ERROR';

export interface LocalWakeEngineOptions {
  onWake?: (capturedPrompt?: string) => void;
  onTranscript?: (transcript: string) => void;
  onStatus?: (status: string) => void;
  onDiagnostic?: (diagnostic: {
    event?: string;
    name?: string;
    level?: number;
    signal?: boolean | string;
    state?: string;
    message?: string;
    mainTranscriptCount?: number;
    preloadTranscriptCount?: number;
  }) => void;
  onError?: (error: Error) => void;
  onStateChange?: (state: LocalWakeLifecycleState) => void;
}

/* ---------- Web Speech API Type Shims ---------- */
interface SpeechResultItem {
  transcript: string;
  confidence: number;
}
interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechResultItem;
}
interface SpeechEvent {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechResult };
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: ((e: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w['SpeechRecognition'] as SpeechRecognitionCtor) ||
    (w['webkitSpeechRecognition'] as SpeechRecognitionCtor) ||
    null
  );
}

export class LocalWakeEngine {
  private state: LocalWakeLifecycleState = 'IDLE';
  private isListening = false;
  private wantRecognition = false;

  /* -- Electron IPC Bridge -- */
  private removeIpcListeners: (() => void) | null = null;
  private pendingTranscript = '';
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly transcriptWindowMs = 1200;
  private electronRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private electronRestartAttempts = 0;
  private readonly maxElectronRestarts = 3;

  /* -- Browser Web Speech Recognition -- */
  private activeRecognition: SpeechRecognitionLike | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private isStartingInstance = false;
  private restartBackoffMs = 150;
  private lastSpawnAt = 0;
  private visibilityHandler: (() => void) | null = null;

  /* -- Rolling transcript buffer -- */
  private recentPhrases: { text: string; ts: number }[] = [];
  private readonly phraseWindowMs = 5000;
  private lastWakeFireAt = 0;
  private readonly wakeCooldownMs = 1500;

  private readonly opts: Required<LocalWakeEngineOptions>;

  constructor(options: LocalWakeEngineOptions = {}) {
    this.opts = {
      onWake: options.onWake ?? (() => undefined),
      onTranscript: options.onTranscript ?? (() => undefined),
      onStatus: options.onStatus ?? (() => undefined),
      onDiagnostic: options.onDiagnostic ?? (() => undefined),
      onError: options.onError ?? (() => undefined),
      onStateChange: options.onStateChange ?? (() => undefined),
    };
  }

  public getState(): LocalWakeLifecycleState {
    return this.state;
  }

  public async requestPermission(): Promise<boolean> {
    console.log('[MIC_PERMISSION_REQUESTED]');
    if (window.seraDesktop?.startLocalSpeech) return true;

    try {
      if (typeof navigator !== 'undefined' && 'permissions' in navigator) {
        const status = await (navigator.permissions as any).query({ name: 'microphone' });
        if (status?.state === 'granted') {
          console.log('[MIC_PERMISSION_ALREADY_GRANTED]');
          return true;
        }
        if (status?.state === 'denied') {
          console.warn('[MIC_PERMISSION_DENIED]');
          this.opts.onDiagnostic({ event: 'MIC_PERMISSION_DENIED', message: 'Microphone permission denied' });
          return false;
        }
      }
    } catch {
      // Permissions API not supported for microphone — proceed, SpeechRecognition will ask
    }

    return true;
  }

  /**
   * Start hands-free wake word listening.
   */
  public async start(): Promise<boolean> {
    if (
      this.isListening ||
      this.state === 'STARTING' ||
      this.state === 'LISTENING' ||
      this.state === 'WAKE_DETECTED'
    ) {
      return true;
    }

    this.setState('STARTING');
    console.log('[LOCAL_SPEECH_INITIALIZING]');

    // 1. Electron Desktop SAPI Bridge (if running in desktop app)
    if (window.seraDesktop?.startLocalSpeech) {
      const electronOk = await this.startElectronPath();
      if (electronOk) return true;
      console.warn(
        '[LOCAL_WAKE_ENGINE] Electron SAPI path failed — falling back to browser Web Speech recognition',
      );
      // Reset the lifecycle so the browser path can take over cleanly.
      this.setState('STARTING');
    }

    // 2. Web Speech API Browser Path
    return this.startBrowserPath();
  }

  /**
   * Stop wake word listening cleanly.
   */
  public stop(): void {
    if (this.state === 'IDLE') return;
    this.setState('STOPPING');
    this.wantRecognition = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Electron cleanup
    window.seraDesktop?.stopLocalSpeech();
    this.removeIpcListeners?.();
    this.removeIpcListeners = null;
    if (typeof document !== 'undefined' && this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    this.restartBackoffMs = 150;
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = null;
    }
    if (this.electronRestartTimer) {
      clearTimeout(this.electronRestartTimer);
      this.electronRestartTimer = null;
    }
    this.electronRestartAttempts = 0;
    this.pendingTranscript = '';
    this.recentPhrases = [];

    // Browser recognition cleanup
    this.cleanupActiveRecognition();

    this.isListening = false;
    console.log('[LOCAL_SPEECH_STOPPED]');
    this.setState('IDLE');
  }

  /* ---------- Electron Desktop SAPI Path ---------- */

  private async startElectronPath(): Promise<boolean> {
    try {
      const onTx = window.seraDesktop!.onLocalSpeechTranscript((payload) => {
        if (typeof payload?.text !== 'string') return;
        const chunk = payload.text.trim();
        if (!chunk) return;

        this.opts.onDiagnostic({
          event: 'IPC_TRANSCRIPT',
          mainTranscriptCount: payload.mainTranscriptCount,
        });

        this.opts.onTranscript(chunk);

        // 1. Instant evaluation on the single chunk (0ms latency)
        if (this.checkAndFireWake(chunk)) return;

        // 2. Rolling multi-chunk buffer for split utterances ("Hey" ... "Sera")
        this.pendingTranscript = `${this.pendingTranscript} ${chunk}`.trim();
        if (this.checkAndFireWake(this.pendingTranscript)) {
          this.pendingTranscript = '';
          return;
        }

        // 3. Trailing window cleanup timer
        if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
        this.transcriptTimer = setTimeout(() => {
          const tx = this.pendingTranscript;
          this.pendingTranscript = '';
          this.transcriptTimer = null;
          if (tx) {
            this.checkAndFireWake(tx);
          }
        }, this.transcriptWindowMs);
      });

      const onStatus = window.seraDesktop!.onLocalSpeechStatus((p) => {
        if (p.status) this.opts.onStatus(p.status);
      });
      const onError = window.seraDesktop!.onLocalSpeechError((p) => {
        this.handleElectronSpeechError(p?.message || 'Local speech failed');
      });
      const onDiag = window.seraDesktop!.onLocalSpeechDiagnostic((p) => {
        this.opts.onDiagnostic(p);
      });

      this.removeIpcListeners = () => {
        onTx();
        onStatus();
        onError();
        onDiag();
      };

      console.log('[Wake] microphone initialized');
      console.log('[Wake] listener started');
      console.log('[Wake] recognition engine: LOCAL');
      console.log('[LOCAL_SPEECH_BRIDGE_CONNECTED]');

      await window.seraDesktop!.startLocalSpeech();
      const workerState = await window.seraDesktop!.getLocalSpeechState();
      if (workerState.state === 'ERROR') {
        throw new Error(`SAPI worker exited: ${workerState.exitCode ?? 'unknown'}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 600));
      const aliveState = await window.seraDesktop!.getLocalSpeechState();
      if (aliveState.state === 'ERROR') {
        throw new Error(`SAPI worker died at startup (exit code ${aliveState.exitCode ?? 'unknown'}) — usually missing Windows speech voices or a locked microphone`);
      }

      this.opts.onStatus('STARTED');
      this.isListening = true;
      this.setState('LISTENING');
      console.log('[LOCAL_SPEECH_READY]');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[LOCAL_SPEECH_ELECTRON_PATH_FAILED]', message);
      this.opts.onDiagnostic({ event: 'ELECTRON_SAPI_FAILED', message });
      this.isListening = false;
      return false;
    }
  }

  /**
   * The SAPI worker reports an error. Instead of dying on the first hiccup
   * (the old behaviour — one async SAPI failure killed wake-word listening
   * for the whole session), retry the worker a few times with backoff.
   * Only a run of consecutive failures surfaces as a user-facing error.
   */
  private handleElectronSpeechError(message: string): void {
    if (!this.isListening && this.state !== 'STARTING') return; // stop() already ran
    if (this.electronRestartAttempts >= this.maxElectronRestarts) {
      this.opts.onError(new Error(message));
      this.setState('ERROR');
      return;
    }
    this.electronRestartAttempts += 1;
    console.warn(
      `[LOCAL_SPEECH_RETRY] ${this.electronRestartAttempts}/${this.maxElectronRestarts} after: ${message}`,
    );
    if (this.electronRestartTimer) clearTimeout(this.electronRestartTimer);
    this.electronRestartTimer = setTimeout(async () => {
      this.electronRestartTimer = null;
      if (!this.isListening && this.state !== 'STARTING') return;
      try {
        await window.seraDesktop?.startLocalSpeech();
        const state = await window.seraDesktop?.getLocalSpeechState();
        if (state && state.state === 'ERROR') throw new Error(`SAPI worker exited: ${state.exitCode ?? 'unknown'}`);
        // Healthy again — clear the failure budget so hiccups hours apart
        // never stack up into a fatal error.
        this.electronRestartAttempts = 0;
        this.opts.onStatus('STARTED');
        this.setState('LISTENING');
        console.log('[LOCAL_SPEECH_RETRY_SUCCESS]');
      } catch (err) {
        this.handleElectronSpeechError(err instanceof Error ? err.message : String(err));
      }
    }, 1500);
  }

  /* ---------- Continuous Browser Web Speech API Path ---------- */

  private startBrowserPath(): boolean {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      console.warn('[SPEECH_RECOGNITION_UNAVAILABLE] Web Speech API not supported in this browser');
      this.opts.onDiagnostic({ event: 'SPEECH_RECOGNITION_UNAVAILABLE' });
      this.fail(new Error('Speech recognition not available in this browser — wake word needs Chrome or Edge'));
      return false;
    }

    console.log('[Wake] microphone initialized');
    console.log('[Wake] listener started');
    console.log('[Wake] recognition engine: ONLINE');

    this.wantRecognition = true;
    this.spawnRecognitionInstance(Ctor);

    // Chrome silently suspends SpeechRecognition while the tab is hidden.
    // When the tab becomes visible again, guarantee an instance is alive.
    if (!this.visibilityHandler && typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (typeof document === 'undefined' || document.visibilityState !== 'visible' || !this.wantRecognition) return;
        if (!this.activeRecognition && !this.isStartingInstance) {
          const freshCtor = getSpeechRecognitionCtor();
          if (freshCtor) this.spawnRecognitionInstance(freshCtor);
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    this.opts.onStatus('STARTED');
    this.isListening = true;
    this.setState('LISTENING');
    console.log('[LOCAL_WAKE_ENGINE_ACTIVE]');
    return true;
  }

  /**
   * Spawns a clean SpeechRecognition instance.
   */
  private spawnRecognitionInstance(Ctor: SpeechRecognitionCtor): boolean {
    if (!this.wantRecognition || this.isStartingInstance) return false;
    this.isStartingInstance = true;

    // Clean up old references without throwing abort errors
    if (this.activeRecognition) {
      try {
        this.activeRecognition.onstart = null;
        this.activeRecognition.onresult = null;
        this.activeRecognition.onerror = null;
        this.activeRecognition.onend = null;
      } catch {
        /* ignore */
      }
      this.activeRecognition = null;
    }

    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      // Match user's preferred language or default to en-US / en-IN
      rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
      rec.maxAlternatives = 5;

      rec.onstart = () => {
        this.isStartingInstance = false;
        this.lastSpawnAt = Date.now();
        this.opts.onDiagnostic({ event: 'AUDIO_CAPTURE_ACTIVE' });
        console.log(`[SPEECH_RECOGNITION_STARTED] lang=${rec.lang} backoff=${this.restartBackoffMs}ms`);
      };

      rec.onresult = (e: SpeechEvent) => {
        const now = Date.now();

        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (!result || result.length === 0) continue;

          // 1. Check all N-best alternative hypotheses immediately
          for (let alt = 0; alt < Math.min(result.length, 5); alt++) {
            const item = result[alt];
            if (!item?.transcript) continue;
            const text = item.transcript.trim();
            if (!text) continue;

            this.opts.onDiagnostic({ event: 'RENDERER_TRANSCRIPT' });

            // Direct single-chunk match
            if (this.checkAndFireWake(text, now)) return;
          }

          // 2. Sliding window for slow multi-chunk utterances ("Hey" ... "Sera")
          const primaryText = result[0]?.transcript?.trim();
          if (primaryText) {
            this.recentPhrases.push({ text: primaryText, ts: now });
            this.recentPhrases = this.recentPhrases.filter((p) => now - p.ts <= this.phraseWindowMs);

            if (this.recentPhrases.length > 1) {
              const combined = this.recentPhrases.map((p) => p.text).join(' ');
              if (this.checkAndFireWake(combined, now)) return;
            }
          }

          if (result.isFinal && result[0]?.transcript) {
            this.opts.onTranscript(result[0].transcript.trim());
          }
        }
      };

      rec.onerror = (e) => {
        this.isStartingInstance = false;
        // no-speech and aborted are completely normal during pauses / restarts
        if (e.error === 'no-speech' || e.error === 'aborted') return;

        console.warn(`[SPEECH_RECOGNITION_NOTICE] ${e.error}`);

        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.opts.onDiagnostic({ event: 'MIC_PERMISSION_DENIED', message: 'Permission denied' });
          this.opts.onStatus('MIC_DENIED');
        } else if (e.error === 'network') {
          this.opts.onStatus('NETWORK');
        } else if (e.error === 'audio-capture') {
          this.opts.onStatus('AUDIO_BUSY');
        }

        this.restartBackoffMs = Math.min(this.restartBackoffMs * 2, 5000);
      };

      rec.onend = () => {
        this.isStartingInstance = false;
        if (!this.wantRecognition) return;

        if (Date.now() - this.lastSpawnAt >= 30000) this.restartBackoffMs = 150;

        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          if (!this.wantRecognition) return;
          const freshCtor = getSpeechRecognitionCtor();
          if (freshCtor) {
            this.spawnRecognitionInstance(freshCtor);
          }
        }, this.restartBackoffMs);
      };

      this.activeRecognition = rec;
      rec.start();
      return true;
    } catch (err) {
      this.isStartingInstance = false;
      console.warn('[SPEECH_RECOGNITION_START_EXCEPTION]', err);
      this.restartBackoffMs = Math.min(this.restartBackoffMs * 2, 5000);
      if (this.wantRecognition && !this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          if (!this.wantRecognition) return;
          const freshCtor = getSpeechRecognitionCtor();
          if (freshCtor) this.spawnRecognitionInstance(freshCtor);
        }, this.restartBackoffMs);
      }
      return false;
    }
  }

  private cleanupActiveRecognition(): void {
    if (this.activeRecognition) {
      try {
        this.activeRecognition.onstart = null;
        this.activeRecognition.onresult = null;
        this.activeRecognition.onerror = null;
        this.activeRecognition.onend = null;
        this.activeRecognition.abort();
      } catch {
        /* ignore */
      }
      this.activeRecognition = null;
    }
  }

  /**
   * Checks transcript for wake word match and fires onWake.
   */
  private checkAndFireWake(text: string, now: number = Date.now()): boolean {
    if (now - this.lastWakeFireAt <= this.wakeCooldownMs) return false;
    if (!text || !text.trim()) return false;

    const trimmed = text.trim();
    const evalResult = evaluateWakePhrase(trimmed);
    if (!evalResult.matched) return false;

    console.log(`[Wake] transcript received: "${trimmed}"`);
    console.log(`[Wake] normalized transcript: "${normalize(trimmed)}"`);
    console.log(`[Wake] wake candidate detected: "${evalResult.wakePhrase}"`);
    console.log(`[Wake] confidence: ${evalResult.confidence.toFixed(2)}`);
    console.log(`[Wake] activation accepted: prompt="${evalResult.command ?? ''}"`);

    this.lastWakeFireAt = now;
    this.recentPhrases = [];
    this.pendingTranscript = '';

    this.opts.onTranscript(trimmed);
    this.opts.onWake(evalResult.command);
    return true;
  }

  private setState(s: LocalWakeLifecycleState): void {
    this.state = s;
    this.opts.onStateChange(s);
  }

  private fail(err: Error): void {
    console.error('[WAKE_ENGINE_ERROR]', err.message);
    this.setState('ERROR');
    this.opts.onError(err);
  }
}
