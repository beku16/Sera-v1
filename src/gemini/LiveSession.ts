import { AudioPlayer } from '../audio/AudioPlayer';
import { AudioStreamer } from '../audio/AudioStreamer';
import { defaultSpeakerManager, ConversationRouter, SpeakerObservation } from '../speakers';
import { getStableAuthorizationId } from '../authorization/AuthorizationIdentity';
import { AssistantStateManager } from '../state/AssistantState';
import {
  AssistantSettings,
  AudioDiagnosticsInfo,
  AudioVisualizerData,
  BrowserActionEvent,
  PaletteActionEvent,
  ToolCallLogItem,
  TranscriptItem,
} from '../types';

export interface LiveSessionCallbacks {
  onTranscript?: (item: TranscriptItem) => void;
  onToolCall?: (item: ToolCallLogItem) => void;
  onBrowserAction?: (event: BrowserActionEvent) => void;
  onPaletteAction?: (event: PaletteActionEvent) => void;
  onDiagnostics?: (info: AudioDiagnosticsInfo) => void;
  onError?: (error: Error) => void;
  onUnexpectedDisconnect?: (reason: string) => void;
  onLatencyUpdate?: (ms: number) => void;
  onSpeakerUpdate?: (observation: SpeakerObservation) => void;
  /** v1.6.10: server-confirmed live screen-share state (the LIVE badge). */
  onScreenShareState?: (state: { active: boolean; reason?: string; fps?: number; framesSent?: number; framesSkipped?: number }) => void;
}

export function openBrowserUrl(url: string): boolean {
  if (typeof window === 'undefined' || !url) return false;

  try {
    const targetWindow = window.open(url, '_blank', 'noopener,noreferrer');
    return !!targetWindow && !targetWindow.closed;
  } catch (err) {
    console.warn('Direct browser navigation notice:', err);
    return false;
  }
}

export class LiveSession {
  private ws: WebSocket | null = null;
  private streamer: AudioStreamer | null = null;
  private player: AudioPlayer | null = null;
  private stateManager: AssistantStateManager;
  private callbacks: LiveSessionCallbacks;
  private settings: AssistantSettings;
  private isConnected: boolean = false;
  private isConnecting: boolean = false;
  private handledBrowserActionIds = new Set<string>();
  private micLevel: number = 0;
  private speakerLevel: number = 0;
  private freqArray: Uint8Array = new Uint8Array(64);
  private readonly conversationRouter = new ConversationRouter();
  private currentSpeaker: SpeakerObservation['speaker'] | null = null;
  private startAttemptId: string = '';
  private sessionId: string = '';
  private authorizationId: string = '';
  private userInitiatedClose: boolean = false;
  private lastAudioChunk: string | null = null;
  private isReady: boolean = false;
  private pendingTextMessages: string[] = [];
  /** Gemini session-resumption handle (latest resumable state). */
  private resumeHandle: string | null = null;
  /** True when THIS session was created to resume a dropped one (auto-reconnect). */
  private readonly isResume: boolean = false;

  constructor(
    stateManager: AssistantStateManager,
    settings: AssistantSettings,
    callbacks: LiveSessionCallbacks = {},
    startAttemptId?: string,
    options?: { resumeHandle?: string }
  ) {
    this.stateManager = stateManager;
    this.settings = settings;
    this.callbacks = callbacks;
    this.startAttemptId = startAttemptId || `start-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.authorizationId = typeof window !== 'undefined' ? getStableAuthorizationId() : this.sessionId;
    this.userInitiatedClose = false;
    // Carried over from the previous session on auto-reconnect so Google's
    // ~7-10 minute Live session limit never appears to the user as "SERA
    // restarted and forgot everything".
    this.resumeHandle = options?.resumeHandle || null;
    this.isResume = Boolean(this.resumeHandle);
    if (this.resumeHandle) {
      console.log(`[SERA] ${this.startAttemptId} ♻️ Reconnecting with Gemini session resume handle`);
    }
  }

  /**
   * Latest resumable session handle reported by the server. The assistant
   * hook reads this on unexpected disconnects so the replacement session
   * can RESUME with full conversation context.
   */
  public getResumeHandle(): string | null {
    return this.resumeHandle;
  }

  /**
   * Connects to the Gemini Live session and starts voice streaming
   */
  public async connect(): Promise<void> {
    console.log(`[SERA] ▶ START REQUESTED`);
    console.log(`[SERA] START ATTEMPT: ${this.startAttemptId}`);
    
    if (this.isConnected || this.isConnecting) {
      console.log(`[SERA] ${this.startAttemptId} Session already connecting/connected, skipping`);
      return;
    }

    this.userInitiatedClose = false;
    this.isConnecting = true;

    this.stateManager.transitionTo('connecting', 'Establishing live audio session');

    try {
      // 1. Initialize AudioPlayer (24kHz output for Gemini Live)
      console.log(`[SERA] ${this.startAttemptId} STEP 1: initializing AudioPlayer`);
      this.player = new AudioPlayer({
        volume: this.settings.outputVolume,
        outputDeviceId: this.settings.outputDeviceId || 'default',
        onPlaybackStart: () => {
          if (this.isConnected) {
            console.log(`[SERA] ${this.startAttemptId} 📢 Playback started - transitioning to speaking`);
            this.stateManager.transitionTo('speaking', 'Sera response playing');
          }
        },
        onPlaybackEnd: () => {
          if (this.isConnected && this.stateManager.getState() === 'speaking') {
            console.log(`[SERA] ${this.startAttemptId} 📢 Playback ended - back to listening`);
            this.stateManager.transitionTo('listening', 'Waiting for user voice input');
          }
        },
        onVolumeChange: (vol) => {
          this.speakerLevel = vol;
        },
        onError: (err) => {
          console.error(`[SERA] ${this.startAttemptId} ❌ AudioPlayer Error:`, err);
          this.handleError(err);
        },
      });

      // Eagerly prime audio playback context on user gesture
      await this.player.init().catch((err) => {
        console.warn(`[SERA] ${this.startAttemptId} AudioContext autoplay warm-up:`, err);
      });
      console.log(`[SERA] ${this.startAttemptId} ✓ STEP 1 COMPLETE: AudioPlayer ready`);

      // 2. Initialize AudioStreamer (16kHz PCM input with hardware DSP & adaptive noise suppression)
      console.log(`[SERA] ${this.startAttemptId} STEP 2: initializing AudioStreamer`);
      this.streamer = new AudioStreamer({
        gain: this.settings.inputGain,
        deviceId: this.settings.inputDeviceId,
        noiseSuppression: this.settings.noiseSuppression,
        echoCancellation: this.settings.echoCancellation,
        autoGainControl: this.settings.autoGainControl,
        startAttemptId: this.startAttemptId,
        enableWakeWord: false,
        onAudioChunk: (base64Chunk) => {
          // If Sera is actively speaking, suppress ambient speaker feedback from looping back into Gemini Live
          // unless user speaks up loudly (barge-in)
          if (this.stateManager.getState() === 'speaking' && this.micLevel < 0.07) {
            return;
          }

          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(
                JSON.stringify({
                  clientSentAt: Date.now(),
                  type: 'audio',
                  data: base64Chunk,
                })
              );
            } catch (err) {
              console.error(`[SERA] ${this.startAttemptId} ❌ Failed to send audio chunk:`, err);
            }
          }
        },
        onSpeakerFrame: (rawPcm, isSpeech) => {
          try {
            if (!this.settings.speakerRecognition || !isSpeech) return;
            const speaker = defaultSpeakerManager.match(rawPcm);
            const previous = this.conversationRouter.getState().currentSpeaker;
            const state = this.conversationRouter.observe(speaker);
            this.currentSpeaker = speaker;
            if (this.ws?.readyState === WebSocket.OPEN && previous?.speakerId !== speaker.speakerId) {
              try {
                this.ws.send(JSON.stringify({ type: 'speaker_context', speakerId: speaker.speakerId, confidence: speaker.confidence, known: speaker.known }));
              } catch (wsErr) {
                console.warn(`[SERA] ${this.startAttemptId} ⚠ Failed to send speaker_context:`, wsErr);
              }
            }
            try {
              this.callbacks.onSpeakerUpdate?.({ speaker, isSpeech, started: previous?.speakerId !== speaker.speakerId, ended: false, timestamp: Date.now() });
            } catch (cbErr) {
              console.warn(`[SERA] ${this.startAttemptId} ⚠ onSpeakerUpdate callback error:`, cbErr);
            }
            void state;
          } catch (err) {
            console.error(`[SERA] ${this.startAttemptId} ❌ onSpeakerFrame error:`, err);
          }
        },
        onVolumeChange: (vol) => {
          this.micLevel = vol;
        },
        onVadUpdate: (vad) => {
          // Intelligent Voice Barge-In:
          // If Sera is currently speaking and user speaks with confirmed speech activity (not steady background noise),
          // trigger immediate interruption.
          if (
            this.stateManager.getState() === 'speaking' &&
            vad.isSpeech &&
            vad.consecutiveSpeechFrames >= 2 &&
            (vad.snrDb >= 5.0 || vad.speechProbability >= 0.75)
          ) {
            console.log(`[SERA] ${this.startAttemptId} 🎤 Voice barge-in detected`);
            this.interrupt();
          }
        },
        onDiagnostics: (info) => {
          if (this.callbacks.onDiagnostics) {
            this.callbacks.onDiagnostics({ ...info, outputContextState: this.player?.getContextState() || 'uninitialized', isOutputPlaying: this.player?.getIsPlaying() || false });
          }
        },
        onError: (err) => {
          console.error(`[SERA] ${this.startAttemptId} ❌ AudioStreamer Error:`, err);
          this.handleError(err);
        },
      });
      console.log(`[SERA] ${this.startAttemptId} ✓ STEP 2 COMPLETE: AudioStreamer ready`);

      // 3. Establish WebSocket connection to backend
      console.log(`[SERA] ${this.startAttemptId} STEP 3: connecting WebSocket to backend`);
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsParams = new URLSearchParams({
        voice: this.settings.voice,
        startAttemptId: this.startAttemptId,
        authorizationId: this.authorizationId,
      });
      if (this.resumeHandle) {
        wsParams.set('resumeHandle', this.resumeHandle);
      }
      const wsUrl = `${protocol}//${window.location.host}/api/live?${wsParams.toString()}`;
      console.log(`[SERA] ${this.startAttemptId}   WebSocket URL: ${wsUrl}`);

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = async () => {
        try {
          console.log(`[SERA] ${this.startAttemptId} ✓ STEP 3 COMPLETE: WebSocket connected`);
          console.log(`[SERA] ${this.startAttemptId} STEP 4: starting microphone capture`);
          // Start capturing mic once WS is established
          if (this.streamer) {
            try {
              await this.streamer.start();
              console.log(`[SERA] ${this.startAttemptId} ✓ STEP 4 COMPLETE: Microphone stream started`);
            } catch (micErr) {
              console.error(`[SERA] ${this.startAttemptId} ❌ STEP 4 FAILED: Microphone start error:`, micErr);
              throw micErr;
            }
          }
          this.isConnected = true;
          // v1.6.8 SILENT RESUME: the wake chime announces "Sera is here".
          // On an auto-reconnect (Google closes Live sessions every ~7-10
          // min) that chime is exactly the "she restarted and told me"
          // cue users hate. A resumed session reconnects in silence —
          // the orb just keeps glowing and the conversation continues.
          if (!this.isResume) {
            // Play acoustic wake acknowledgment chime
            void this.player?.playWakeChime();
          } else {
            console.log(`[SERA] ${this.startAttemptId} ♻️ Resume reconnect — skipping wake chime (silent)`);
          }
          console.log(`[SERA] ${this.startAttemptId} STEP 5: gemini live session active`);
          this.stateManager.transitionTo('listening', 'Microphone active, listening');
          console.log(`[SERA] ${this.startAttemptId} ✓ STEP 5 COMPLETE: Session listening`);
        } catch (err) {
          console.error(`[SERA] ${this.startAttemptId} ❌ FAILED IN onopen:`, err);
          this.handleError(err instanceof Error ? err : new Error('Microphone permission denied or unavailable'));
        }
      };

      this.ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'ready') {
            this.isReady = true;
            console.log(`[SERA] ${this.startAttemptId} ✓ STEP 6: Gemini Live session ready`);
            this.stateManager.transitionTo('listening', 'Sera is listening');
            console.log(`[SERA] ${this.startAttemptId} ✓ SESSION ACTIVE - READY FOR AUDIO`);

            // Flush any pending text messages that were queued before session became ready
            while (this.pendingTextMessages.length > 0) {
              const textToSend = this.pendingTextMessages.shift();
              if (textToSend && this.ws && this.ws.readyState === WebSocket.OPEN) {
                console.log(`[SERA] ${this.startAttemptId} 📤 Flushing queued text to backend: "${textToSend}"`);
                this.ws.send(
                  JSON.stringify({
                    type: 'text',
                    text: textToSend,
                  })
                );
              }
            }
          } else if (msg.type === 'audio' && msg.data) {
            if (this.player) {
              void this.player.queueAudioChunk(msg.data);
            }
          } else if (msg.type === 'session_handle') {
            // Server forwarded a fresh Gemini session-resumption handle.
            // Stored so an unexpected disconnect can resume the SAME
            // conversation transparently (no re-greet, no context loss).
            if (typeof msg.handle === 'string' && msg.handle) {
              this.resumeHandle = msg.handle;
              console.log(`[SERA] ${this.startAttemptId} ♻️ Session resume handle updated`);
            }
          } else if (msg.type === 'interrupted') {
            // Model noticed user interruption
            console.log(`[SERA] ${this.startAttemptId} 🎤 User interrupted Sera`);
            this.interrupt();
          } else if (msg.type === 'transcript') {
              if (this.callbacks.onTranscript) {
              this.callbacks.onTranscript({
                id: String(Date.now()) + Math.random().toString(36).substring(2, 6),
                sender: msg.sender === 'user' ? 'user' : 'sera',
                text: typeof msg.text === 'string' ? msg.text : '',
                timestamp: Date.now(),
                isPartial: msg.isPartial === true || msg.final === false,
                speakerId: this.currentSpeaker?.speakerId,
                speakerName: this.currentSpeaker?.name,
                speakerConfidence: this.currentSpeaker?.confidence,
              });
            }
          } else if (msg.type === 'tool_call') {
            if (this.callbacks.onToolCall) {
              this.callbacks.onToolCall({
                id: msg.id,
                name: msg.name,
                args: msg.args,
                status: 'executing',
                timestamp: Date.now(),
              });
            }
          } else if (msg.type === 'browser_action' && msg.action === 'open_url') {
            const actionId = String(msg.id || msg.url || '');
            if (!actionId || this.handledBrowserActionIds.has(actionId)) {
              return;
            }
            this.handledBrowserActionIds.add(actionId);
            const openedDirectly = openBrowserUrl(msg.url);

            if (this.callbacks.onBrowserAction) {
              this.callbacks.onBrowserAction({
                id: msg.id || String(Date.now()),
                url: msg.url,
                domain: msg.domain || '',
                siteName: msg.siteName || msg.domain || 'Website',
                openedDirectly,
                timestamp: Date.now(),
              });
            }
          } else if (msg.type === 'palette_action' && msg.palette) {
            this.callbacks.onPaletteAction?.({
              id: msg.id || String(Date.now()),
              palette: msg.palette,
              timestamp: Date.now(),
            });
          } else if (msg.type === 'screen_share_state') {
            // v1.6.10: server-confirmed live screen share — drives the red
            // LIVE badge in the UI. Sent on start, stop, and stale-state
            // mirroring (session rollover cleanup).
            console.log(`[SERA] ${this.startAttemptId} 🖥️ Screen share ${msg.active ? 'LIVE' : 'OFF'}${msg.reason ? ` (${msg.reason})` : ''}`);
            this.callbacks.onScreenShareState?.({
              active: msg.active === true,
              reason: typeof msg.reason === 'string' ? msg.reason : undefined,
              fps: typeof msg.fps === 'number' ? msg.fps : undefined,
              framesSent: typeof msg.framesSent === 'number' ? msg.framesSent : undefined,
              framesSkipped: typeof msg.framesSkipped === 'number' ? msg.framesSkipped : undefined,
            });
          } else if (msg.type === 'tool_result') {
            if (this.callbacks.onToolCall) {
              this.callbacks.onToolCall({
                id: msg.id,
                name: msg.name,
                args: {},
                status: msg.success ? 'success' : 'failed',
                result: msg.data,
                error: msg.error,
                timestamp: Date.now(),
              });
            }
          } else if (msg.type === 'error') {
            console.error('[SERA] ❌ Server error:', msg.error);
            this.handleError(new Error(msg.error || 'Server reported an error'));
          } else if (msg.type === 'session_closed') {
            console.log(`[SERA] ${this.startAttemptId} ⏹ Server closed session`);
            this.handleRemoteSessionClosed('Server closed the live session');
          }
        } catch (err) {
          console.error('[SERA] ❌ Message parse error:', err);
        }
      };

      this.ws.onerror = (wsErr: Event) => {
        console.error(`[SERA] ${this.startAttemptId} ❌ WebSocket error:`, wsErr);
        this.handleError(new Error('Connection error occurred'));
      };

      this.ws.onclose = (closeEvent: CloseEvent) => {
        const closeInitiator = this.userInitiatedClose ? 'CLIENT_USER' : 'SERVER_OR_NETWORK';
        const clientState = this.stateManager.getState();
        const diagnostics = {
          sessionId: this.sessionId,
          startAttemptId: this.startAttemptId,
          closeInitiator,
          closeCode: closeEvent.code,
          closeReason: closeEvent.reason || '(no reason provided)',
          wasClean: closeEvent.wasClean,
          clientState,
          isConnected: this.isConnected,
          isConnecting: this.isConnecting,
          timestamp: new Date().toISOString(),
        };
        
        console.log(`[SERA] ${this.startAttemptId} 🔴 WEBSOCKET CLOSE DIAGNOSTICS:`);
        console.log(JSON.stringify(diagnostics, null, 2));

        if (this.userInitiatedClose) {
          return;
        }

        this.isConnected = false;
        this.isConnecting = false;
        this.cleanupAudio();
        const reason = 'Remote close: ' + (closeEvent.reason || 'connection closed');
        // v1.6.8 SILENT RESUME: when we hold a resume handle, the very next
        // thing that happens is an automatic reconnect that restores the
        // same conversation. Dropping the orb all the way to STANDBY for a
        // second made every Google-side session rollover look like "Sera
        // restarted herself". Stay in 'connecting' instead — the glow
        // simply continues — and the resumed session takes over from there.
        if (this.resumeHandle) {
          this.stateManager.transitionTo('connecting', 'Resuming live session…');
        } else {
          this.stateManager.transitionTo('disconnected', reason);
        }
        this.callbacks.onUnexpectedDisconnect?.(reason);
      };
    } catch (err) {
      console.error(`[SERA] ${this.startAttemptId} ❌ Connection FAILED:`, err);
      this.handleError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * Interrupts currently playing speech immediately
   */
  public interrupt(): void {
    this.lastAudioChunk = null;
    if (this.player) {
      this.player.interrupt();
    }
    if (this.isConnected && this.stateManager.getState() === 'speaking') {
      this.stateManager.transitionTo('listening', 'Interrupted by user');
    }
  }

  /**
   * Returns true only when the Gemini Live session on backend is fully active and ready for input
   */
  public getIsReady(): boolean {
    return this.isReady;
  }

  /**
   * Sends text input (for keyboard accessibility or fallbacks)
   */
  public sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    if (this.callbacks.onTranscript) {
      this.callbacks.onTranscript({
        id: String(Date.now()),
        sender: 'user',
        text: trimmed,
        timestamp: Date.now(),
      });
    }

    if (this.isReady && this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`[SERA] ${this.startAttemptId} 📤 Sending text to live session: "${trimmed}"`);
      this.ws.send(
        JSON.stringify({
          type: 'text',
          text: trimmed,
        })
      );
    } else {
      console.log(`[SERA] ${this.startAttemptId} ⏳ Session not ready yet, queuing text message: "${trimmed}"`);
      this.pendingTextMessages.push(trimmed);
    }
  }

  /**
   * v1.6.10 — user-initiated "stop screen share" (the LIVE badge button).
   * The server kills the frame feed AND the underlying sharing state, then
   * confirms with a screen_share_state event.
   */
  public stopScreenShare(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log(`[SERA] ${this.startAttemptId} 🖥️ Requesting screen share stop`);
      try {
        this.ws.send(JSON.stringify({ type: 'screen_share_stop' }));
      } catch (err) {
        console.warn('[SERA] screen_share_stop send failed:', err);
      }
    }
  }

  /**
   * v1.7.0 — ONE-SHOT screen frame over the live socket. Used when the
   * user asks a screen question while continuous Screen Vision is OFF:
   * the frame rides this socket so it lands BEFORE the question text on
   * the same ordered connection — the model sees the screen at the exact
   * moment of asking.
   */
  public sendScreenFrame(frame: {
    data: string;
    mimeType: 'image/jpeg';
    width: number;
    height: number;
    bytes: number;
    at: number;
  }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'screen_frame',
          data: frame.data,
          mimeType: frame.mimeType,
          width: frame.width,
          height: frame.height,
          bytes: frame.bytes,
          at: frame.at,
        }),
      );
    } catch (err) {
      console.warn(`[SERA] ${this.startAttemptId} screen_frame send failed:`, err);
    }
  }

  /**
   * Updates settings during session
   */
  public updateSettings(newSettings: Partial<AssistantSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    if (newSettings.inputGain !== undefined && this.streamer) {
      this.streamer.setGain(newSettings.inputGain);
    }
    if (newSettings.outputVolume !== undefined && this.player) {
      this.player.setVolume(newSettings.outputVolume);
    }
  }

  /**
   * Gets visualizer levels and frequency data for UI rendering
   */
  public getVisualizerData(): AudioVisualizerData {
    const isSpeaking = this.stateManager.getState() === 'speaking';
    const isListening = this.stateManager.getState() === 'listening';

    if (isSpeaking && this.player) {
      this.player.getFrequencyData(this.freqArray);
    } else if (isListening && this.streamer) {
      this.streamer.getFrequencyData(this.freqArray);
    } else {
      this.freqArray.fill(0);
    }

    return {
      micLevel: isListening ? this.micLevel : 0,
      speakerLevel: isSpeaking ? this.speakerLevel : 0,
      frequencies: this.freqArray,
    };
  }

  /**
   * Gets current audio diagnostics info
   */
  public getAudioDiagnostics(): AudioDiagnosticsInfo | null {
    if (this.streamer) {
      return this.streamer.getDiagnostics();
    }
    return null;
  }

  /**
   * Returns the AudioContext state for the streamer (mic) and player
   * (speaker) channels. Used by the watchdog effect in useAssistant to
   * detect and recover from suspended contexts (e.g. after the tab was
   * backgrounded). Was previously missing — calling it threw
   * `TypeError: liveSessionRef.current.getAudioContextStates is not a
   * function` from the watchdog interval.
   */
  public getAudioContextStates(): { streamer: AudioContextState | 'closed' | 'uninitialized'; player: AudioContextState | 'closed' | 'uninitialized' } {
    return {
      streamer: this.streamer?.getContextState() ?? 'uninitialized',
      player: this.player?.getContextState() ?? 'closed',
    };
  }

  /**
   * Resumes the streamer (and player if applicable) AudioContexts after the
   * browser has auto-suspended them. Browsers suspend AudioContexts when a
   * tab is backgrounded or after long idle; without this recovery path the
   * mic stops picking up audio and Sera stops responding.
   */
  public async resumeAudio(): Promise<void> {
    try {
      if (this.streamer) await this.streamer.resume();
    } catch (err) {
      console.warn('[SERA] Failed to resume streamer audio context:', err);
    }
    // AudioPlayer has no public resume() — but its ensureReady() (called on
    // the next playAudioChunk) auto-recreates a closed context and resumes a
    // suspended one. So no explicit call needed here; the next chunk from
    // Gemini will self-heal.
  }

  /**
   * Handles error condition and initiates recovery
   */
  private handleError(error: Error): void {
    console.error('[SERA] 🔴 STOP TRIGGERED - Error Handler:', error.message);
    this.stateManager.setError(error.message || 'An unexpected error occurred in live session');

    if (this.callbacks.onError) {
      this.callbacks.onError(error);
    }

    this.cleanupAudio();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.isConnected = false;
  }

  private cleanupAudio(): void {
    if (this.streamer) {
      this.streamer.stop();
      this.streamer = null;
    }
    if (this.player) {
      this.player.close();
      this.player = null;
    }
    this.micLevel = 0;
    this.speakerLevel = 0;
  }

  private handleRemoteSessionClosed(reason: string): void {
    if (this.userInitiatedClose) {
      return;
    }

    console.log(`[SERA] ${this.startAttemptId} 🛑 Remote session shutdown: ${reason}`);
    this.isConnecting = false;
    this.isConnected = false;
    this.lastAudioChunk = null;
    this.cleanupAudio();
    this.stateManager.transitionTo('disconnected', reason);
    this.callbacks.onUnexpectedDisconnect?.(reason);
  }

  /**
   * Disconnects cleanly and releases all resources
   */
  public disconnect(): void {
    console.log(`[SERA] ${this.startAttemptId} 🛑 STOP REQUESTED - User initiated disconnect`);
    this.userInitiatedClose = true;
    this.isConnecting = false;
    this.isConnected = false;
    this.handledBrowserActionIds.clear();
    this.lastAudioChunk = null;
    this.cleanupAudio();

    if (this.ws) {
      try {
        console.log(`[SERA] ${this.startAttemptId} Closing WebSocket - User initiated`);
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close(1000, 'User initiated close');
        }
      } catch (err) {
        console.warn(`[SERA] ${this.startAttemptId} Error closing WebSocket:`, err);
      }
      this.ws = null;
    }

    this.stateManager.transitionTo('disconnected', 'User closed live session');
  }

  public getIsConnected(): boolean {
    return this.isConnected;
  }
}








