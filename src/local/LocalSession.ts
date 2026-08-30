import { AudioPlayer } from '../audio/AudioPlayer';
import { arrayBufferToBase64, float32ToInt16Pcm } from '../audio/audioUtils';
import { extractWakePrompt } from '../audio/wakePhrase';
import { AssistantStateManager } from '../state/AssistantState';
import { matchSleepIntent } from '../utils/sleepCommands';
import type {
  AssistantSettings,
  AudioDiagnosticsInfo,
  AudioVisualizerData,
  BrowserActionEvent,
  PaletteActionEvent,
  ToolCallLogItem,
  TranscriptItem,
} from '../types';
import type { LiveSessionCallbacks } from '../gemini/LiveSession';
import { openBrowserUrl } from '../gemini/LiveSession';
import { getStableAuthorizationId } from '../authorization/AuthorizationIdentity';

/* ── Minimal Web Speech API typings (not in lib.dom for all TS versions) ── */
interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike { isFinal: boolean; 0: SpeechRecognitionAlternativeLike; length: number }
interface SpeechRecognitionEventLike { resultIndex: number; results: { length: number; [index: number]: SpeechRecognitionResultLike } }
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/* ── Whisper voice-path constants ───────────────────────────────── */
const VAD_START_SPEECH_FRAMES = 3;      // ~120 ms above threshold = speech onset
const VAD_END_QUIET_FRAMES = 22;        // ~0.9 s of silence finalizes the utterance
const VAD_MAX_UTTERANCE_FRAMES = 16000 * 15; // hard 15 s cap per utterance
const VAD_MIN_UTTERANCE_FRAMES = 16000 * 0.25; // <0.25 s = noise, dropped
const VAD_SPEAKING_BOOST = 1.8;         // higher energy bar while SERA talks (echo guard)

/** Linear-interpolation resampler: native capture rate → 16 kHz mono. */
function resampleTo16k(input: Float32Array, nativeRate: number): Float32Array {
  if (nativeRate === 16000) return input;
  const ratio = nativeRate / 16000;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * LOCAL MODE session — SERA's 100% offline / zero-cloud path.
 *
 * Pairs with the server's `runLocalLiveSession`:
 *   - Text: typed input → /api/live WS (mode=local) → Ollama agent loop
 *     with full tool execution, identical event rendering.
 *   - Voice input (whisper installed): the mic streams 16 kHz PCM through
 *     an energy-VAD gate into the server's local whisper engine — 100%
 *     offline, works identically in the desktop app and the browser, and
 *     transcribed speech runs the SAME agent turn as typed text.
 *   - Voice input (no whisper): Electron SAPI dictation bridge in the
 *     desktop app, Web Speech API in a plain browser. Browser Web
 *     Speech CANNOT work inside Electron (it needs Google's speech
 *     service), so the desktop app falls back to the SAPI bridge.
 *   - Voice output: browser speechSynthesis (TTS) so replies are spoken
 *     without any cloud dependency.
 *   - Wake chime + output device selection reuse the continuous FIFO
 *     AudioPlayer from the online path.
 */
export class LocalSession {
  private ws: WebSocket | null = null;
  private player: AudioPlayer | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private micStream: MediaStream | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micContext: AudioContext | null = null;
  private micLevelArray: Uint8Array = new Uint8Array(64);
  private stateManager: AssistantStateManager;
  private callbacks: LiveSessionCallbacks;
  private settings: AssistantSettings;
  private isConnected = false;
  private isConnecting = false;
  private isReady = false;
  private userInitiatedClose = false;
  private micLevel = 0;
  private speakerLevel = 0;
  private freqArray: Uint8Array = new Uint8Array(64);
  private pendingTextMessages: string[] = [];
  private handledBrowserActionIds = new Set<string>();
  private readonly startAttemptId: string;
  private readonly sessionId: string;
  private sttFallbackNotified = false;
  /* -- Desktop (Electron SAPI bridge) STT state -- */
  private desktopStt = false;
  private desktopUnsubscribers: Array<() => void> = [];
  private desktopErrorNotified = false;
  /* -- Browser STT: set once a persistent failure kills the recognizer so
        the onend auto-restart loop cannot resurrect a dead service. -- */
  private browserSttStopped = false;
  /* -- Whisper PCM voice input (fully offline STT through the server) -- */
  private whisperVoice = false;
  private pcmProcessor: ScriptProcessorNode | null = null;
  private pcmSink: GainNode | null = null;
  private pcmSourceNode: MediaStreamAudioSourceNode | null = null;
  private vadSpeechStarted = false;
  private vadSpeechFrames = 0;
  private vadQuietFrames = 0;
  private vadBufferedFrames = 0;
  private vadChunks: Int16Array[] = [];
  private vadPreRoll: Int16Array[] = [];
  private vadNoiseFloor = 260;           // adaptive RMS floor (int16 scale)
  private micProblemNotified = false;

  constructor(
    stateManager: AssistantStateManager,
    settings: AssistantSettings,
    callbacks: LiveSessionCallbacks = {},
    startAttemptId?: string,
  ) {
    this.stateManager = stateManager;
    this.settings = settings;
    this.callbacks = callbacks;
    this.startAttemptId = startAttemptId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  public async connect(): Promise<void> {
    if (this.isConnected || this.isConnecting) return;
    this.userInitiatedClose = false;
    this.isConnecting = true;
    this.stateManager.transitionTo('connecting', 'Establishing local offline session');

    try {
      // 1. AudioPlayer for the wake chime (and any server PCM later).
      this.player = new AudioPlayer({
        volume: this.settings.outputVolume,
        outputDeviceId: this.settings.outputDeviceId || 'default',
        onPlaybackStart: () => {
          if (this.isConnected) this.stateManager.transitionTo('speaking', 'Local response playing');
        },
        onPlaybackEnd: () => {
          if (this.isConnected && this.stateManager.getState() === 'speaking') {
            this.stateManager.transitionTo('listening', 'Waiting for user voice input');
          }
        },
        onVolumeChange: (vol) => { this.speakerLevel = vol; },
        onError: (err) => this.handleError(err),
      });
      await this.player.init().catch(() => undefined);
      void this.player.playWakeChime();

      // 2. WebSocket to the local agent.
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({
        mode: 'local',
        startAttemptId: this.startAttemptId,
        // Same stable authorization identity the online session uses —
        // without it, tool capability checks see an anonymous ephemeral
        // session and deny every system tool (open apps, websites,
        // search), which made Local Mode look completely broken.
        authorizationId: getStableAuthorizationId(),
        ...(this.settings.localModel ? { model: this.settings.localModel } : {}),
      });
      this.ws = new WebSocket(`${protocol}//${window.location.host}/api/live?${params.toString()}`);

      this.ws.onmessage = (event) => {
        try {
          this.handleServerMessage(JSON.parse(event.data));
        } catch (err) {
          console.error('[SERA-LOCAL] Message parse error:', err);
        }
      };

      this.ws.onerror = () => {
        this.handleError(new Error('Local session connection error — is the SERA server running?'));
      };

      this.ws.onclose = (closeEvent: CloseEvent) => {
        if (this.userInitiatedClose) return;
        this.isConnected = false;
        this.isConnecting = false;
        this.stopRecognition();
        this.stopMicMeter();
        const reason = 'Local session closed: ' + (closeEvent.reason || 'connection closed');
        this.stateManager.transitionTo('disconnected', reason);
        this.callbacks.onUnexpectedDisconnect?.(reason);
      };

      // 3. Voice input strategy — when local whisper is installed the mic
      //    streams PCM into the offline STT engine (works in the desktop
      //    app AND the browser, no Google speech service needed). Without
      //    whisper we keep the previous paths: Electron SAPI bridge or
      //    browser Web Speech.
      const whisperReady = await this.probeWhisperStt();
      if (whisperReady) {
        this.whisperVoice = await this.startMicCapture();
        if (this.whisperVoice) {
          console.log('[SERA-LOCAL] 🎙 Whisper voice path active — 100% offline mic');
        }
      }
      if (!this.whisperVoice) {
        const sttStarted = this.startRecognition();
        if (!sttStarted) {
          console.warn('[SERA-LOCAL] Browser speech recognition unavailable — text input still works.');
        }
        // Mic level meter for the visualizer (no PCM leaves the machine).
        await this.startMicMeter().catch((err) => this.notifyMicProblem(err));
      }

      this.isConnected = true;
      this.isConnecting = false;
      this.stateManager.transitionTo('listening', 'Local offline mode active — listening');
      console.log(`[SERA-LOCAL] ${this.startAttemptId} ✓ Local session active`);
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isConnecting = false;
    }
  }

  private handleServerMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ready':
        this.isReady = true;
        this.flushPendingText();
        break;

      // v1.9.0 (spec §52): the saved model vanished from Ollama. Surface an
      // explicit notice with the three fixes (reinstall / choose another /
      // system check) — never a silent substitution by another model.
      case 'model_missing': {
        const model = typeof msg.model === 'string' ? msg.model : 'the selected model';
        const notice = typeof msg.message === 'string'
          ? msg.message
          : `The selected model "${model}" is not installed in Ollama anymore. Reinstall it or choose another in Settings → MY PC.`;
        console.warn(`[SERA-LOCAL] ⚠ Model missing: ${model}`);
        this.callbacks.onTranscript?.({
          id: `model-missing-${Date.now()}`,
          sender: 'sera',
          text: notice,
          timestamp: Date.now(),
          isPartial: false,
        });
        break;
      }

      case 'transcript': {
        const sender = msg.sender === 'user' ? 'user' : 'sera';
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!text) break;
        // Smart barge-in (whisper path + typed-text echo): the moment the
        // user's words arrive while she talks, cut her voice.
        if (sender === 'user' && msg.isPartial !== true && this.stateManager.getState() === 'speaking') {
          console.log('[SERA-LOCAL] 🎤 User speech while SERA speaking — auto barge-in');
          this.interrupt();
        }
        this.callbacks.onTranscript?.({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sender,
          text,
          timestamp: Date.now(),
          isPartial: msg.isPartial === true,
        });
        // Speak Sera's local replies via browser TTS.
        if (sender === 'sera' && msg.isPartial !== true) {
          this.speak(text);
        }
        break;
      }

      case 'status':
        if (msg.state === 'processing') {
          this.stateManager.transitionTo('processing', 'Local model is thinking');
        }
        break;

      case 'turn_complete':
        if (this.isConnected && ['processing', 'speaking'].includes(this.stateManager.getState())) {
          this.stateManager.transitionTo('listening', 'Waiting for user voice input');
        }
        break;

      case 'tool_call':
        this.callbacks.onToolCall?.({
          id: String(msg.id || Date.now()),
          name: String(msg.name || 'tool'),
          args: (msg.args as Record<string, unknown>) || {},
          status: 'executing',
          timestamp: Date.now(),
        });
        break;

      case 'tool_result':
        this.callbacks.onToolCall?.({
          id: String(msg.id || Date.now()),
          name: String(msg.name || 'tool'),
          args: {},
          status: msg.success ? 'success' : 'failed',
          result: msg.data,
          error: typeof msg.error === 'string' ? msg.error : undefined,
          timestamp: Date.now(),
        });
        break;

      case 'browser_action': {
        if (msg.action !== 'open_url' || typeof msg.url !== 'string') break;
        const actionId = String(msg.id || msg.url || '');
        if (!actionId || this.handledBrowserActionIds.has(actionId)) break;
        this.handledBrowserActionIds.add(actionId);
        const openedDirectly = openBrowserUrl(msg.url);
        this.callbacks.onBrowserAction?.({
          id: actionId,
          url: msg.url,
          domain: String(msg.domain || ''),
          siteName: String(msg.siteName || msg.domain || 'Website'),
          openedDirectly,
          timestamp: Date.now(),
        });
        break;
      }

      case 'palette_action':
        if (typeof msg.palette === 'string') {
          this.callbacks.onPaletteAction?.({
            id: String(msg.id || Date.now()),
            palette: msg.palette as PaletteActionEvent['palette'],
            timestamp: Date.now(),
          });
        }
        break;

      case 'interrupted':
        this.interrupt();
        break;

      case 'stt_unavailable': {
        // Server whisper missing — browser STT is already the primary path;
        // notify once so the user understands why voice may be limited.
        if (!this.sttFallbackNotified) {
          this.sttFallbackNotified = true;
          this.callbacks.onError?.(new Error(String(msg.reason || 'Local speech-to-text is not installed; using browser speech recognition.')));
        }
        break;
      }

      case 'error':
        console.error('[SERA-LOCAL] Server error:', msg.error);
        this.callbacks.onError?.(new Error(String(msg.error || 'Local session error')));
        break;

      default:
        break;
    }
  }

  /** Speaks text through the Web Speech Synthesis API (offline voices). */
  private speak(text: string): void {
    try {
      if (!('speechSynthesis' in window) || !text.trim()) {
        // No TTS available — flash speaking state briefly for orb feedback.
        if (this.isConnected) {
          this.stateManager.transitionTo('speaking', 'Local response (text only)');
          window.setTimeout(() => {
            if (this.isConnected && this.stateManager.getState() === 'speaking') {
              this.stateManager.transitionTo('listening', 'Waiting for user voice input');
            }
          }, Math.min(6000, 400 + text.length * 12));
        }
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.volume = Math.max(0, Math.min(1, this.settings.outputVolume));
      utterance.rate = 1.04;
      utterance.onstart = () => {
        if (this.isConnected) this.stateManager.transitionTo('speaking', 'Local response playing');
      };
      utterance.onend = () => {
        if (this.isConnected && this.stateManager.getState() === 'speaking') {
          this.stateManager.transitionTo('listening', 'Waiting for user voice input');
        }
      };
      utterance.onerror = () => {
        if (this.isConnected && this.stateManager.getState() === 'speaking') {
          this.stateManager.transitionTo('listening', 'Waiting for user voice input');
        }
      };
      window.speechSynthesis.speak(utterance);
    } catch (err) {
      console.warn('[SERA-LOCAL] TTS notice:', err);
    }
  }

  private startRecognition(): boolean {
    // 1. SERA desktop app → Windows SAPI bridge. The browser Web Speech API
    //    is NOT functional inside Electron (its audio upload to Google's
    //    speech service aborts in a loop), so the desktop app MUST use the
    //    local bridge — trying Web Speech here is what produced endless
    //    `OnSizeReceived failed with Error: -2` network-service spam.
    if (window.seraDesktop?.startLocalSpeech) {
      return this.startDesktopRecognition();
    }
    // 2. Plain browser → Web Speech API.
    return this.startBrowserRecognition();
  }

  /**
   * Shared pipeline for a FINAL desktop-STT utterance: strip the wake
   * phrase, apply the speaking-state guards (self-hearing suppression +
   * barge-in), emit the transcript and forward it to the agent.
   * Returns true when the utterance produced a transcript event.
   */
  private handleVoiceTranscript(raw: string, idPrefix: string): boolean {
    // If the user addresses SERA by name inside the session, strip the
    // wake phrase ("hey sera open chrome" → "open chrome"). A bare wake
    // word alone is noise here, not a command.
    const prompt = extractWakePrompt(raw);
    const text = (prompt === null ? raw : (prompt ?? '')).trim();
    if (!text) return false;

    const speakingNow = this.stateManager.getState() === 'speaking';
    if (speakingNow) {
      const intent = matchSleepIntent(text);
      if (intent === 'sleep') {
        // Control commands must pass through even while she talks.
        this.callbacks.onTranscript?.({
          id: `${idPrefix}${Date.now()}`,
          sender: 'user',
          text,
          timestamp: Date.now(),
          isPartial: false,
        });
        this.sendText(text);
        return true;
      }
      // Real user speech while SERA speaks → smart barge-in: cut her voice
      // NOW and process the utterance. Everything else (usually her own
      // TTS echoing back through the mic) is suppressed.
      console.log('[SERA-LOCAL] 🎤 User speech while SERA speaking — auto barge-in');
      this.interrupt();
      this.callbacks.onTranscript?.({
        id: `${idPrefix}${Date.now()}`,
        sender: 'user',
        text,
        timestamp: Date.now(),
        isPartial: false,
      });
      this.sendText(text);
      return true;
    }

    this.callbacks.onTranscript?.({
      id: `${idPrefix}${Date.now()}`,
      sender: 'user',
      text,
      timestamp: Date.now(),
      isPartial: false,
    });
    this.sendText(text);
    return true;
  }

  /**
   * Desktop voice input: subscribe to the shared SAPI dictation worker via
   * IPC and become an owner so the worker outlives the wake-word listener
   * handing over control to this session.
   */
  private startDesktopRecognition(): boolean {
    const desktop = window.seraDesktop;
    if (!desktop?.startLocalSpeech || !desktop.onLocalSpeechTranscript) return false;
    this.desktopStt = true;
    this.desktopErrorNotified = false;

    this.desktopUnsubscribers.push(
      desktop.onLocalSpeechTranscript((payload) => {
        if (typeof payload?.text !== 'string') return;
        const raw = payload.text.trim();
        if (raw.length < 2) return;
        const handled = this.handleVoiceTranscript(raw, 'stt-desktop-');
        if (!handled) return;
      }),
      desktop.onLocalSpeechError((payload) => {
        if (this.desktopErrorNotified) return;
        this.desktopErrorNotified = true;
        this.callbacks.onError?.(new Error(String(payload?.message || 'Desktop speech recognition failed — voice input is unavailable. Text chat still works.')));
      }),
    );

    void desktop
      .startLocalSpeech()
      .then(() => desktop.getLocalSpeechState())
      .then((state) => {
        if (state.state === 'ERROR') {
          throw new Error(`SAPI worker exited: ${state.exitCode ?? 'unknown'}`);
        }
        console.log(`[SERA-LOCAL] Desktop STT active (pid=${state.pid}, owners=${state.owners})`);
      })
      .catch((err) => {
        if (this.desktopErrorNotified) return;
        this.desktopErrorNotified = true;
        this.callbacks.onError?.(new Error(err instanceof Error ? err.message : 'Desktop speech recognition could not start — voice input is unavailable. Text chat still works.'));
      });
    return true;
  }

  private startBrowserRecognition(): boolean {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return false;
    this.browserSttStopped = false;
    try {
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript || '';
          if (!text.trim()) continue;
          // While SERA is speaking: suppress her own voice coming back
          // through the mic (echo) unless the utterance is a real control
          // command, and let genuine user speech barge in.
          const speakingNow = this.stateManager.getState() === 'speaking';
          if (speakingNow) {
            const intent = matchSleepIntent(text);
            if (intent) {
              if (!result.isFinal) continue;
              this.callbacks.onTranscript?.({
                id: `stt-${i}-${Date.now()}`,
                sender: 'user',
                text: text.trim(),
                timestamp: Date.now(),
                isPartial: false,
              });
              if (intent === 'sleep') {
                this.sendText(text.trim());
              } else {
                this.interrupt();
              }
              continue;
            }
            if (!result.isFinal) continue;
            // Real user speech while she talks → smart barge-in: cut her
            // voice IMMEDIATELY and process the utterance normally.
            console.log('[SERA-LOCAL] 🎤 User speech while SERA speaking — auto barge-in');
            this.interrupt();
            this.callbacks.onTranscript?.({
              id: `stt-${i}-${Date.now()}`,
              sender: 'user',
              text: text.trim(),
              timestamp: Date.now(),
              isPartial: false,
            });
            this.sendText(text.trim());
            continue;
          }
          this.callbacks.onTranscript?.({
            id: `stt-${i}-${Date.now()}`,
            sender: 'user',
            text: text.trim(),
            timestamp: Date.now(),
            isPartial: !result.isFinal,
          });
          if (result.isFinal) {
            // Final user utterance → send to the local agent.
            this.sendText(text.trim());
          }
        }
      };

      recognition.onerror = (event) => {
        const code = event?.error || 'unknown';
        if (code === 'no-speech' || code === 'aborted') return;
        console.warn('[SERA-LOCAL] Speech recognition error:', code);
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'network') {
          // These failures are persistent. Restarting the recognizer in a
          // loop (the old behaviour) just hammers a dead service — for
          // 'network' the audio upload to the speech backend aborts forever.
          // Stop cleanly and tell the user what still works.
          this.callbacks.onError?.(new Error(
            code === 'network'
              ? 'Browser voice input is unreachable (speech service blocked or offline). Text chat still works — and the SERA desktop app has built-in offline voice.'
              : 'Microphone permission denied — local voice input unavailable. Text chat still works.',
          ));
          this.browserSttStopped = true;
          this.stopRecognition();
        }
      };

      recognition.onend = () => {
        // Chrome stops recognition periodically — restart while connected,
        // but never resurrect a recognizer we deliberately stopped after a
        // persistent failure (permission denied / network unreachable).
        if (this.browserSttStopped) return;
        if (this.isConnected && !this.userInitiatedClose) {
          try {
            recognition.start();
          } catch {
            // start() can throw if already started — safe to ignore.
          }
        }
      };

      recognition.start();
      this.recognition = recognition;
      return true;
    } catch (err) {
      console.warn('[SERA-LOCAL] Could not start speech recognition:', err);
      return false;
    }
  }

  private stopRecognition(): void {
    if (this.desktopStt) {
      for (const unsubscribe of this.desktopUnsubscribers) {
        try { unsubscribe(); } catch { /* best-effort */ }
      }
      this.desktopUnsubscribers = [];
      this.desktopStt = false;
      void window.seraDesktop?.stopLocalSpeech().catch(() => undefined);
      return;
    }
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.abort();
      } catch { /* best-effort */ }
      this.recognition = null;
    }
  }

  /** Probes the server: is the offline whisper STT engine installed? */
  private async probeWhisperStt(): Promise<boolean> {
    try {
      const res = await fetch('/api/local/status');
      if (!res.ok) return false;
      const status = (await res.json()) as { speech?: { stt?: { available?: boolean } } };
      return status?.speech?.stt?.available === true;
    } catch {
      return false;
    }
  }

  /**
   * Full mic capture for the whisper voice path: same Discord-style
   * constraints as the visualizer tap, plus a ScriptProcessor tap that
   * converts the stream into 16 kHz PCM frames gated by an energy VAD.
   * Returns false (after notifying) when the mic itself is unavailable.
   */
  private async startMicCapture(): Promise<boolean> {
    try {
      await this.startMicMeter();
    } catch (err) {
      this.notifyMicProblem(err);
      return false;
    }
    if (!this.micContext || !this.micStream) {
      this.notifyMicProblem(new Error('Audio context failed to initialise'));
      return false;
    }
    try {
      this.pcmSourceNode = this.micContext.createMediaStreamSource(this.micStream);
      const processor = this.micContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => this.handlePcmFrame(event.inputBuffer);
      // ScriptProcessor only pulls when connected into the graph — route it
      // through a zero-gain node so nothing is actually played out loud.
      this.pcmSink = this.micContext.createGain();
      this.pcmSink.gain.value = 0;
      this.pcmSourceNode.connect(processor);
      processor.connect(this.pcmSink);
      this.pcmSink.connect(this.micContext.destination);
      this.pcmProcessor = processor;
      return true;
    } catch (err) {
      this.notifyMicProblem(err);
      return false;
    }
  }

  /** One ~85 ms audio frame from the mic tap: resample, VAD, buffer. */
  private handlePcmFrame(buffer: AudioBuffer): void {
    if (!this.whisperVoice || !this.isConnected) return;
    const mono = buffer.getChannelData(0);
    const pcm16 = float32ToInt16Pcm(resampleTo16k(mono, buffer.sampleRate));
    if (pcm16.length === 0) return;

    // Frame energy on the int16 scale (0..32768).
    let sum = 0;
    for (let i = 0; i < pcm16.length; i++) { const v = pcm16[i]; sum += v * v; }
    const rms = Math.sqrt(sum / pcm16.length);

    // Adaptive noise floor: drifts down in quiet, up very slowly in noise.
    this.vadNoiseFloor = rms < this.vadNoiseFloor
      ? this.vadNoiseFloor * 0.96 + rms * 0.04
      : this.vadNoiseFloor * 0.995 + rms * 0.005;
    const speakingNow = this.stateManager.getState() === 'speaking';
    const threshold = Math.max(170, this.vadNoiseFloor * 2.4) * (speakingNow ? VAD_SPEAKING_BOOST : 1);

    if (!this.vadSpeechStarted) {
      if (rms > threshold) {
        this.vadSpeechFrames += 1;
        if (this.vadSpeechFrames >= VAD_START_SPEECH_FRAMES) {
          // Speech confirmed — seed the utterance with the pre-roll so the
          // first syllable is not clipped, then start accumulating.
          this.vadSpeechStarted = true;
          this.vadQuietFrames = 0;
          this.vadChunks = [...this.vadPreRoll];
          this.vadBufferedFrames = this.vadPreRoll.reduce((acc, c) => acc + c.length, 0);
          this.vadPreRoll = [];
          this.appendUtteranceChunk(pcm16);
        }
      } else {
        this.vadSpeechFrames = 0;
        this.vadPreRoll.push(pcm16);
        if (this.vadPreRoll.length > 2) this.vadPreRoll.shift();
      }
      return;
    }

    // Utterance in progress.
    this.appendUtteranceChunk(pcm16);
    if (rms > threshold) {
      this.vadQuietFrames = 0;
    } else {
      this.vadQuietFrames += 1;
      if (this.vadQuietFrames >= VAD_END_QUIET_FRAMES) {
        this.finalizeUtterance('silence');
        return;
      }
    }
    if (this.vadBufferedFrames >= VAD_MAX_UTTERANCE_FRAMES) {
      this.finalizeUtterance('max-length');
    }
  }

  private appendUtteranceChunk(pcm16: Int16Array): void {
    this.vadChunks.push(pcm16);
    this.vadBufferedFrames += pcm16.length;
  }

  /** Ships the buffered utterance to the server for whisper transcription. */
  private finalizeUtterance(reason: 'silence' | 'max-length'): void {
    const wasSpeaking = this.vadSpeechStarted;
    this.vadSpeechStarted = false;
    this.vadQuietFrames = 0;
    this.vadSpeechFrames = 0;
    this.vadPreRoll = [];
    if (!wasSpeaking) return;

    const chunks = this.vadChunks;
    const totalFrames = this.vadBufferedFrames;
    this.vadChunks = [];
    this.vadBufferedFrames = 0;

    if (totalFrames < VAD_MIN_UTTERANCE_FRAMES) return; // stray click / cough
    const merged = new Int16Array(totalFrames);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isReady) {
      this.ws.send(JSON.stringify({ type: 'audio', data: arrayBufferToBase64(merged.buffer) }));
      this.stateManager.transitionTo('processing', `Voice captured (${reason === 'silence' ? 'end of speech' : 'buffer full'}) — transcribing locally`);
      console.log(`[SERA-LOCAL] 🎙 Sent ${(totalFrames / 16000).toFixed(1)}s utterance to local whisper`);
    } else {
      console.warn('[SERA-LOCAL] Utterance dropped — local socket not ready');
    }
  }

  /** One-shot, non-fatal notice that the mic is unusable. */
  private notifyMicProblem(err: unknown): void {
    if (this.micProblemNotified) return;
    this.micProblemNotified = true;
    const detail = err instanceof Error ? err.message : String(err);
    console.warn('[SERA-LOCAL] Microphone unavailable:', detail);
    this.callbacks.onError?.(new Error(
      'SERA cannot access your microphone, so voice input is off. Check the Windows microphone permission and the mic selected in Settings → Audio. Text chat still works.',
    ));
  }

  /** Mic tap purely for visualizer levels — audio never leaves the device. */
  private async startMicMeter(): Promise<void> {
    // Honor the same Discord-style audio settings as the online session:
    // chosen input device + noise suppression / echo cancellation / auto
    // gain. Previously this used a bare `audio: true`, which ignored every
    // setting and could grab a different microphone than the one the user
    // picked in Settings.
    const audio: MediaTrackConstraints = {
      noiseSuppression: this.settings.noiseSuppression ?? true,
      echoCancellation: this.settings.echoCancellation ?? true,
      autoGainControl: this.settings.autoGainControl ?? true,
    };
    if (this.settings.inputDeviceId && this.settings.inputDeviceId !== 'default') {
      audio.deviceId = { exact: this.settings.inputDeviceId };
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    this.micStream = stream;
    const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.micContext = new AudioCtxClass();
    const source = this.micContext.createMediaStreamSource(stream);
    this.micAnalyser = this.micContext.createAnalyser();
    this.micAnalyser.fftSize = 256;
    this.micAnalyser.smoothingTimeConstant = 0.8;
    source.connect(this.micAnalyser);
  }

  private stopMicMeter(): void {
    if (this.pcmProcessor) {
      try {
        this.pcmProcessor.onaudioprocess = null;
        this.pcmProcessor.disconnect();
      } catch { /* best-effort */ }
      this.pcmProcessor = null;
    }
    if (this.pcmSink) {
      try { this.pcmSink.disconnect(); } catch { /* best-effort */ }
      this.pcmSink = null;
    }
    if (this.pcmSourceNode) {
      try { this.pcmSourceNode.disconnect(); } catch { /* best-effort */ }
      this.pcmSourceNode = null;
    }
    this.whisperVoice = false;
    this.vadSpeechStarted = false;
    this.vadChunks = [];
    this.vadPreRoll = [];
    this.vadBufferedFrames = 0;
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        try { track.stop(); } catch { /* best-effort */ }
      }
      this.micStream = null;
    }
    if (this.micAnalyser) {
      try { this.micAnalyser.disconnect(); } catch { /* best-effort */ }
      this.micAnalyser = null;
    }
    if (this.micContext && this.micContext.state !== 'closed') {
      void this.micContext.close();
      this.micContext = null;
    }
    this.micLevel = 0;
  }

  private flushPendingText(): void {
    while (this.pendingTextMessages.length > 0) {
      const text = this.pendingTextMessages.shift();
      if (text) this.sendText(text);
    }
  }

  public interrupt(): void {
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch { /* best-effort */ }
    this.player?.interrupt();
    if (this.isConnected && this.stateManager.getState() === 'speaking') {
      this.stateManager.transitionTo('listening', 'Interrupted by user');
    }
  }

  public getIsReady(): boolean {
    return this.isReady;
  }

  /** Local sessions have no cloud resumption handle — always null. */
  public getResumeHandle(): string | null {
    return null;
  }

  public sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.isReady && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'text', text: trimmed }));
    } else {
      this.pendingTextMessages.push(trimmed);
    }
  }

  /**
   * v1.6.10 — API parity with LiveSession. The offline brain has no live
   * screen-share feed (the local /api/live path never starts one), so this
   * is a deliberate no-op that keeps the useAssistant hook type-safe.
   */
  public stopScreenShare(): void {
    /* no-op in local mode */
  }

  public updateSettings(newSettings: Partial<AssistantSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    if (newSettings.outputVolume !== undefined && this.player) {
      this.player.setVolume(newSettings.outputVolume);
    }
  }

  public getVisualizerData(): AudioVisualizerData {
    const isSpeaking = this.stateManager.getState() === 'speaking';
    const isListening = this.stateManager.getState() === 'listening';

    if (isListening && this.micAnalyser) {
      this.micAnalyser.getByteFrequencyData(this.micLevelArray as Uint8Array<ArrayBuffer>);
      // Approximate RMS level from frequency bins.
      let sum = 0;
      for (let i = 0; i < this.micLevelArray.length; i++) sum += this.micLevelArray[i];
      this.micLevel = Math.min(1, sum / (this.micLevelArray.length * 140));
    } else {
      this.micLevel = 0;
    }

    if (isSpeaking && this.player) {
      this.player.getFrequencyData(this.freqArray);
    } else {
      this.freqArray.fill(0);
    }

    return {
      micLevel: isListening ? this.micLevel : 0,
      speakerLevel: isSpeaking ? this.speakerLevel : 0,
      frequencies: this.freqArray,
    };
  }

  public getAudioDiagnostics(): AudioDiagnosticsInfo | null {
    return null; // Local mode diagnostics come from /api/local/echo-test.
  }

  public getAudioContextStates(): { streamer: AudioContextState | 'closed' | 'uninitialized'; player: AudioContextState | 'closed' | 'uninitialized' } {
    return {
      streamer: this.micContext ? this.micContext.state : 'uninitialized',
      player: this.player?.getContextState() ?? 'closed',
    };
  }

  public async resumeAudio(): Promise<void> {
    try {
      if (this.micContext?.state === 'suspended') await this.micContext.resume();
    } catch (err) {
      console.warn('[SERA-LOCAL] Failed to resume mic context:', err);
    }
  }

  private handleError(error: Error): void {
    console.error('[SERA-LOCAL] 🔴 Error handler:', error.message);
    this.stateManager.setError(error.message || 'Local session error');
    this.callbacks.onError?.(error);
    this.cleanup();
    this.isConnected = false;
  }

  private cleanup(): void {
    this.stopRecognition();
    this.stopMicMeter();
    if (this.player) {
      this.player.close();
      this.player = null;
    }
  }

  public disconnect(): void {
    console.log(`[SERA-LOCAL] ${this.startAttemptId} 🛑 Local session disconnect requested`);
    this.userInitiatedClose = true;
    this.isConnecting = false;
    this.isConnected = false;
    this.isReady = false;
    this.handledBrowserActionIds.clear();
    this.interrupt();
    this.cleanup();

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'User initiated close');
        }
      } catch { /* best-effort */ }
      this.ws = null;
    }

    this.stateManager.transitionTo('disconnected', 'Local session closed');
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }
}
