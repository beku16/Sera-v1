import { useCallback, useEffect, useRef, useState } from 'react';
import { APP_CONFIG } from '../config/config';
import { LiveSession } from '../gemini/LiveSession';
import { LocalSession } from '../local/LocalSession';
import { AssistantStateManager } from '../state/AssistantState';
import { matchSleepIntent, SLEEP_FAREWELL } from '../utils/sleepCommands';
import { useScreenShare, UseScreenShareResult } from './useScreenShare';
import {
  AssistantSettings,
  AssistantStateType,
  AudioDiagnosticsInfo,
  AudioVisualizerData,
  BrowserActionEvent,
  ToolCallLogItem,
  TranscriptItem,
} from '../types';
import { SpeakerObservation } from '../speakers';

const SETTINGS_STORAGE_KEY = 'sera_assistant_settings_v1';

/**
 * Timestamp of the last wake-greeting prompt (module scope: survives
 * session restarts within this app lifetime). The Live backend sometimes
 * closes sessions abruptly; without this guard every auto-reconnect or
 * rapid "hey sera" re-greeted the user, which they experienced as
 * "SERA keeps restarting". A fresh greeting more often than every 90s is
 * noise, not warmth.
 */
let lastGreetingSentAt = 0;

/**
 * True when SERA is in FULL SLEEP (the user said "full quit" / "bye" /
 * "stop listening"…). Module scope so the sleep survives session restarts
 * within the app lifetime; the wake-word listener stays OFF until the user
 * clicks or types to her. This is the guarantee behind "when I need you I
 * will ask" — after a quit command she can NEVER interrupt again.
 */
let seraFullyAsleep = false;

export function mergeTranscriptItem(previous: TranscriptItem[], incoming: TranscriptItem): TranscriptItem[] {
  if (!incoming.text || !incoming.text.trim()) return previous;
  if (previous.length === 0) return [incoming];

  const lastIndex = previous.length - 1;
  const last = previous[lastIndex];

  // If incoming message is from the SAME speaker, group it together in one bubble!
  if (last && last.sender === incoming.sender) {
    // If incoming text already contains the previous text (e.g. cumulative STT updates like "hel" -> "hello")
    if (incoming.text.startsWith(last.text)) {
      const merged: TranscriptItem = {
        ...last,
        ...incoming,
        id: last.id,
        text: incoming.text,
        timestamp: incoming.timestamp || last.timestamp,
        isPartial: incoming.isPartial,
      };
      return [...previous.slice(0, lastIndex), merged];
    }

    // If it's an incremental delta chunk from streaming (e.g. "Well hello" + "there." + "What's" + "happening?")
    const needsSpace =
      last.text.length > 0 &&
      !last.text.endsWith(' ') &&
      !last.text.endsWith('\n') &&
      !incoming.text.startsWith(' ') &&
      !incoming.text.startsWith('\n') &&
      !/^[.,!?;:'")\]]/.test(incoming.text);

    const combinedText = last.text + (needsSpace ? ' ' : '') + incoming.text;
    const merged: TranscriptItem = {
      ...last,
      ...incoming,
      id: last.id,
      text: combinedText,
      timestamp: incoming.timestamp || last.timestamp,
      isPartial: incoming.isPartial,
    };
    return [...previous.slice(0, lastIndex), merged];
  }

  // New speaker turn -> start a new bubble
  return [...previous.slice(-29), incoming];
}

export function useAssistant() {
  // Settings loaded from local storage
  const [settings, setSettings] = useState<AssistantSettings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        return { ...APP_CONFIG.defaultSettings, ...JSON.parse(saved) };
      }
    } catch {}
    return APP_CONFIG.defaultSettings;
  });

  const [state, setState] = useState<AssistantStateType>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [toolLogs, setToolLogs] = useState<ToolCallLogItem[]>([]);
  const [activeBrowserAction, setActiveBrowserAction] = useState<BrowserActionEvent | null>(null);
  const [diagnostics, setDiagnostics] = useState<AudioDiagnosticsInfo | null>(null);
  const [visualizerData, setVisualizerData] = useState<AudioVisualizerData>({
    micLevel: 0,
    speakerLevel: 0,
    frequencies: new Uint8Array(64),
  });
  const [speakerObservation, setSpeakerObservation] = useState<SpeakerObservation | null>(null);
  const [sleepMode, setSleepMode] = useState<boolean>(seraFullyAsleep);
  /** v1.6.10: server-confirmed live screen share — drives the LIVE badge. */
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);

  /** Resume handle from the last Gemini session — lets a reconnect RESUME
   *  the conversation (context preserved) instead of starting a fresh one
   *  that re-introduces itself. */
  const lastResumeHandleRef = useRef<string | null>(null);

  const stateManagerRef = useRef<AssistantStateManager>(new AssistantStateManager('idle'));
  const liveSessionRef = useRef<LiveSession | LocalSession | null>(null);
  const tabId = useRef(`tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).current;
  const isStartingSessionRef = useRef(false);
  const animFrameRef = useRef<number | null>(null);
  const browserActionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectRequestedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Cross-tab coordination: Prevent duplicate audio/mic sessions if user opens multiple tabs
  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel('sera_tab_coordination_channel');

    channel.onmessage = (event) => {
      const { type, senderTabId } = event.data || {};
      if (type === 'CLAIM_ACTIVE_SESSION' && senderTabId !== tabId) {
        // Another tab has become active -> disconnect this tab to eliminate double audio & feedback
        if (liveSessionRef.current && liveSessionRef.current.getIsConnected()) {
          console.log('[SERA] Disconnecting background tab because another tab became active');
          liveSessionRef.current.disconnect();
          stateManagerRef.current.transitionTo('idle', 'Sera is active in another tab');
        }
      }
    };

    return () => {
      channel.close();
    };
  }, [tabId]);

  // Sync settings changes to storage and session (debounced to avoid blocking slider dragging)
  const updateSettings = useCallback((newSettings: Partial<AssistantSettings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        try {
          localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(updated));
        } catch {}
      }, 250);

      if (liveSessionRef.current) {
        liveSessionRef.current.updateSettings(updated);
      }
      return updated;
    });
  }, []);

  // Initialize and handle state transitions
  useEffect(() => {
    const sm = stateManagerRef.current;
    const unsubscribe = sm.subscribe((newState) => {
      setState(newState);
      setErrorMessage(sm.getErrorMessage());
    });

    return () => {
      unsubscribe();
      if (liveSessionRef.current) {
        liveSessionRef.current.disconnect();
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (browserActionTimerRef.current) {
        clearTimeout(browserActionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void liveSessionRef.current?.resumeAudio();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (state !== 'listening' && state !== 'speaking') return;
    const watchdog = window.setInterval(() => {
      const states = liveSessionRef.current?.getAudioContextStates();
      if (states?.player === 'suspended' || states?.streamer === 'suspended') {
        void liveSessionRef.current?.resumeAudio();
      }
    }, 2000);
    return () => window.clearInterval(watchdog);
  }, [state]);

  // High-performance visualizer animation loop (throttled to 30 FPS to keep React main thread silky smooth)
  useEffect(() => {
    let active = true;
    let lastUpdate = 0;

    const renderLoop = (now: number) => {
      if (!active) return;

      if (now - lastUpdate >= 33) {
        lastUpdate = now;
        if (liveSessionRef.current && liveSessionRef.current.getIsConnected()) {
          const data = liveSessionRef.current.getVisualizerData();
          setVisualizerData({
            micLevel: data.micLevel,
            speakerLevel: data.speakerLevel,
            frequencies: new Uint8Array(data.frequencies),
          });
        } else {
          setVisualizerData((prev) => {
            if (prev.micLevel === 0 && prev.speakerLevel === 0) return prev;
            return {
              micLevel: 0,
              speakerLevel: 0,
              frequencies: new Uint8Array(64),
            };
          });
        }
      }

      animFrameRef.current = requestAnimationFrame(renderLoop);
    };

    animFrameRef.current = requestAnimationFrame(renderLoop);

    return () => {
      active = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [state]);

  // ── DUAL-MODE ENGINE SELECTION (spec A: Local ⇄ Online) ──────────
  // Local Mode builds a LocalSession (Ollama offline brain + browser
  // STT/TTS); Online Mode builds the Gemini LiveSession. Everything
  // downstream is duck-typed to the shared session surface.
  const runMode = settings.runMode === 'local' ? 'local' : 'online';

  // v1.7.0 — BROWSER SCREEN SHARE + SCREEN VISION. Stable ref-reading
  // callbacks (never stale, never new identity) feed the hook the CURRENT
  // session/mode at call time; the stable identities keep useScreenShare's
  // memoized result out of the 30fps visualizer re-render path.
  const runModeRef = useRef(runMode);
  useEffect(() => {
    runModeRef.current = runMode;
  }, [runMode]);
  const getRunModeForShare = useCallback<'online' | 'local'>(() => runModeRef.current, []);
  const getLiveSessionForShare = useCallback<() => LiveSession | LocalSession | null>(() => liveSessionRef.current, []);
  const screenShare = useScreenShare({
    getRunMode: getRunModeForShare,
    getLiveSession: getLiveSessionForShare,
  });
  const screenShareRef = useRef<UseScreenShareResult>(screenShare);
  useEffect(() => {
    screenShareRef.current = screenShare;
  }, [screenShare]);

  // Stable ref so the mode-switch effect can trigger the latest startSession.
  const startSessionRef = useRef<((prompt?: string, opts?: { isReconnect?: boolean }) => Promise<void>) | null>(null);

  // 1-click mode switcher: if a session is live when the mode flips,
  // restart it seamlessly on the new engine.
  const previousRunModeRef = useRef(runMode);
  useEffect(() => {
    if (previousRunModeRef.current === runMode) return;
    previousRunModeRef.current = runMode;
    const session = liveSessionRef.current;
    const wasActive = Boolean(session?.getIsConnected()) || state === 'connecting';
    if (wasActive) {
      console.log(`[SERA] 🔄 Mode switched to ${runMode.toUpperCase()} — restarting session`);
      session?.disconnect();
      liveSessionRef.current = null;
      const restartTimer = setTimeout(() => {
        void startSessionRef.current?.();
      }, 350);
      return () => clearTimeout(restartTimer);
    }
    return undefined;
  }, [runMode, state]);

  const dismissBrowserAction = useCallback(() => {
    setActiveBrowserAction(null);
    if (browserActionTimerRef.current) {
      clearTimeout(browserActionTimerRef.current);
      browserActionTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (state === 'listening' || state === 'speaking') {
      reconnectAttemptsRef.current = 0;
      reconnectRequestedRef.current = false;
      return;
    }
    // v1.6.8 SILENT RESUME: LiveSession now keeps the orb on the 'connecting'
    // glow (instead of dropping to 'disconnected') when a resumable session
    // closes unexpectedly. The auto-reconnect trigger must therefore ALSO
    // accept state === 'connecting' when a reconnect was requested —
    // otherwise a silently-resumed drop would never reconnect at all.
    const reconnectEligibleState = state === 'disconnected' || state === 'error' || (state === 'connecting' && reconnectRequestedRef.current);
    if (!reconnectEligibleState || !reconnectRequestedRef.current || !settings.autoReconnect) return;
    // v1.6.9: the DIRECT scheduler (below) is now the primary reconnect
    // trigger — it fires straight from onUnexpectedDisconnect with no
    // dependence on React re-renders. This effect remains as a backup for
    // states the direct path cannot see, but must never double-schedule.
    if (reconnectTimerRef.current) return;
    if (reconnectAttemptsRef.current >= 3) {
      reconnectRequestedRef.current = false;
      // v1.6.8: silent resume gave up. Do not leave the orb stuck on the
      // 'connecting' glow that the resumed close now uses — surface an
      // honest state and tell the user how to bring her back.
      stateManagerRef.current.transitionTo('disconnected', 'Could not reconnect after 3 attempts');
      setErrorMessage('Connection dropped and could not be restored. Click the mic (or say "Hey Sera") to start again.');
      return;
    }
    reconnectRequestedRef.current = false;
    reconnectAttemptsRef.current += 1;
    const delayMs = Math.min(1000 * (2 ** (reconnectAttemptsRef.current - 1)), 8000);
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void startSession(undefined, { isReconnect: true });
    }, delayMs);
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [state, settings.autoReconnect]);

  // ── v1.6.9 FIX: DIRECT reconnect scheduler ──────────────────────────
  // FIELD FAILURE this replaces: after Google dropped the Gemini socket
  // (both logged deaths came 15-20s after a screenshot tool call), the
  // client went to the silent-resume 'connecting' glow and NEVER tried to
  // reconnect — the server log shows zero new connections between the
  // drop and the next manual wake. Root cause: the old scheduler lived
  // in a useEffect keyed on [state, ...]. When the drop happened while
  // the state was ALREADY 'connecting' (or the transition was a no-op
  // because AssistantStateManager skips same-value transitions), React
  // never re-rendered, the effect never re-ran, and the requested flag
  // sat unused forever — the orb showed "connecting" for eternity.
  //
  // The scheduler now runs DIRECTLY from onUnexpectedDisconnect. It only
  // touches refs (never React state) so no render dependency can starve
  // it. The effect above stays as a backup but can no longer double-
  // schedule (timer-pending guard).
  const autoReconnectRef = useRef(settings.autoReconnect);
  useEffect(() => {
    autoReconnectRef.current = settings.autoReconnect;
  }, [settings.autoReconnect]);

  const scheduleReconnectRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    scheduleReconnectRef.current = () => {
      if (!autoReconnectRef.current) return;
      if (reconnectTimerRef.current) return; // attempt already pending
      if (reconnectAttemptsRef.current >= 3) {
        reconnectRequestedRef.current = false;
        reconnectAttemptsRef.current = 0;
        stateManagerRef.current.transitionTo('disconnected', 'Could not reconnect after 3 attempts');
        setErrorMessage('Connection dropped and could not be restored. Click the mic (or say "Hey Sera") to start again.');
        return;
      }
      reconnectRequestedRef.current = false;
      reconnectAttemptsRef.current += 1;
      const attempt = reconnectAttemptsRef.current;
      const delayMs = Math.min(1000 * (2 ** (attempt - 1)), 8000);
      console.log(`[SERA] 🔁 Silent resume: reconnect attempt ${attempt}/3 in ${delayMs}ms`);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        void startSessionRef.current?.(undefined, { isReconnect: true });
      }, delayMs);
    };
  }, []);

  /**
   * FULL SLEEP — the answer to "we full quit, when I need you I will ask".
   * Speaks a short local farewell (never through the LLM — that would just
   * start another conversation), disconnects the live session, blocks the
   * auto-reconnect and turns the wake-word listener OFF. SERA stays
   * completely silent until the user clicks her or types a message.
   */
  const enterSleepMode = useCallback((spokenCommand?: string) => {
    seraFullyAsleep = true;
    setSleepMode(true);
    reconnectRequestedRef.current = false;
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // Visible record of the command + confirmation bubble (silent for the
    // model — this never reaches Gemini/Ollama).
    if (spokenCommand) {
      setTranscripts((prev) => mergeTranscriptItem(prev, {
        id: `sleep-${Date.now()}`,
        sender: 'user',
        text: spokenCommand,
        timestamp: Date.now(),
        isPartial: false,
      }));
    }
    setTranscripts((prev) => mergeTranscriptItem(prev, {
      id: `sleep-ack-${Date.now()}`,
      sender: 'sera',
      text: SLEEP_FAREWELL,
      timestamp: Date.now(),
      isPartial: false,
    }));

    // Kill the live session FIRST (cancels any playing TTS), then speak the
    // farewell through the OS voice so it is heard even after disconnect.
    if (liveSessionRef.current) {
      liveSessionRef.current.disconnect();
      liveSessionRef.current = null;
    }
    stateManagerRef.current.transitionTo('disconnected', 'Sera is fully asleep');

    try {
      if ('speechSynthesis' in window && SLEEP_FAREWELL) {
        const utterance = new SpeechSynthesisUtterance(SLEEP_FAREWELL);
        utterance.volume = Math.max(0, Math.min(1, 0.9));
        utterance.rate = 1.02;
        window.speechSynthesis.speak(utterance);
      }
    } catch { /* best-effort — the text bubble already confirms */ }
  }, []);

  /** Wake from full sleep: clears the block, then behaves like a normal start. */
  const wakeFromSleep = useCallback(() => {
    if (!seraFullyAsleep) return;
    console.log('[SERA] ☀️ Waking from full sleep (user clicked/typed)');
    seraFullyAsleep = false;
    setSleepMode(false);
  }, []);

  // Connect to Sera on Wake Word activation
  const startSession = useCallback(async (initialPrompt?: string, opts?: { isReconnect?: boolean }) => {
    // Full sleep: NOTHING wakes her by voice. Only an explicit user click
    // (toggleSession) or typed message (sendTextOrWake) may pass, because
    // both call wakeFromSleep() first.
    if (seraFullyAsleep && !opts?.isReconnect) {
      console.log('[SERA] 😴 Fully asleep — ignoring wake attempt');
      return;
    }
    // v1.6.8: a resume-reconnect arrives while the state still shows
    // 'connecting' (the silent-resume close keeps the glow alive). The old
    // guard rejected any start while 'connecting' — which would have made
    // every silent resume a no-op. Reconnects pass through.
    if (isStartingSessionRef.current || (!opts?.isReconnect && state !== 'disconnected' && state !== 'error' && state !== 'idle')) {
      // Session already active or connecting — queue or send directly
      if (initialPrompt && liveSessionRef.current) {
        // sendText handles queuing if not yet ready
        liveSessionRef.current.sendText(initialPrompt);
      }
      return;
    }

    const startAttemptId = `wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`[SERA] 🔔 Wake word activated — starting live session. Prompt:`, initialPrompt || '(voice)');

    // Claim exclusivity across all open browser tabs to completely prevent double audio
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const channel = new BroadcastChannel('sera_tab_coordination_channel');
        channel.postMessage({ type: 'CLAIM_ACTIVE_SESSION', senderTabId: tabId });
        channel.close();
      } catch {}
    }
    
    isStartingSessionRef.current = true;
    setErrorMessage(null);
    // v1.6.8 SILENT RESUME: a resume-reconnect must not flash WAKING UP →
    // CONNECTING at the user. The session was never really "stopped" from
    // their point of view — LiveSession keeps the 'connecting' glow through
    // the rollover, so only a genuine wake gets the wake transition.
    if (!opts?.isReconnect) {
      stateManagerRef.current.transitionTo('wake_word_detected', 'Wake word detected');
    }

    const sessionCallbacks = {
      onTranscript: (item) => {
        // ── HARD CONTROL INTENTS (deterministic, before any LLM) ──
        // The user explicitly told SERA "we full quit, when I need you I
        // will ask" and she kept interrupting. Quit/sleep/stop phrases are
        // intercepted here so they can never become chat output or another
        // model turn.
        if (item.sender === 'user' && item.isPartial !== true) {
          const intent = matchSleepIntent(item.text);
          if (intent === 'sleep') {
            console.log('[SERA] 😴 Sleep command detected — going fully quiet');
            enterSleepMode(item.text);
            return;
          }
          if (intent === 'stop_speaking') {
            console.log('[SERA] 🤫 Stop-speaking command — interrupting output only');
            liveSessionRef.current?.interrupt();
            return;
          }
        }
        setTranscripts((prev) => mergeTranscriptItem(prev, item));
      },
      onSpeakerUpdate: (observation) => setSpeakerObservation(observation),
      onToolCall: (item) => {
        setToolLogs((prev) => {
          const index = prev.findIndex((log) => log.id === item.id);
          if (index >= 0) {
            const clone = [...prev];
            clone[index] = { ...clone[index], ...item };
            return clone;
          }
          return [...prev.slice(-15), item];
        });
      },
      onBrowserAction: (actionEvent) => {
        setActiveBrowserAction(actionEvent);
        if (browserActionTimerRef.current) {
          clearTimeout(browserActionTimerRef.current);
        }
        browserActionTimerRef.current = setTimeout(() => {
          setActiveBrowserAction(null);
        }, 10000);
      },
      onPaletteAction: (actionEvent) => {
        updateSettings({ palette: actionEvent.palette });
      },
      onDiagnostics: (info) => {
        setDiagnostics(info);
      },
      onScreenShareState: (shareState) => {
        // v1.6.10: the server is the source of truth (start via tool call,
        // stop via tool call / user button / session death).
        setIsScreenSharing(shareState.active);
      },
      onUnexpectedDisconnect: () => {
        // Preserve the resumable session context so the auto-reconnect
        // RESUMES the same conversation instead of starting a fresh one.
        const handle = liveSessionRef.current?.getResumeHandle?.() || null;
        if (handle) lastResumeHandleRef.current = handle;
        reconnectRequestedRef.current = true;
        // v1.6.9: schedule DIRECTLY — do not wait for a React render that
        // may never come (same-value state transitions don't notify).
        scheduleReconnectRef.current?.();
      },
      onError: (err) => {
        console.error(`[SERA] ${startAttemptId} Hook: onError called:`, err.message);
        setErrorMessage(err.message || 'An error occurred with Sera');
      },
    };

    // On auto-reconnect, hand Gemini the previous session's resume handle:
    // the new Live session restores the full conversation context, so the
    // 7-8 minute Google-side session limit becomes completely invisible —
    // no re-introduction, no lost context, no spoken greeting.
    const resumeHandle = opts?.isReconnect ? lastResumeHandleRef.current || undefined : undefined;

    const session = runMode === 'local'
      ? new LocalSession(
          stateManagerRef.current,
          settings,
          sessionCallbacks,
          startAttemptId,
        )
      : new LiveSession(
          stateManagerRef.current,
          settings,
          sessionCallbacks,
          startAttemptId,
          { resumeHandle },
        );

    liveSessionRef.current = session;
    try {
      await session.connect();

      // Wait for server to signal 'ready' (Gemini Live fully connected), up to 7s
      const waitForReady = async (maxMs: number): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
          if (session.getIsReady()) return true;
          await new Promise((r) => setTimeout(r, 80));
        }
        return session.getIsReady();
      };

      const isReady = await waitForReady(7000);
      if (!isReady) {
        console.warn('[SERA] Session ready timed out — trying to send anyway');
      }

      if (initialPrompt) {
        // User sent a message — deliver it directly, no greeting needed
        console.log(`[SERA] Delivering user message after wake: "${initialPrompt}"`);
        session.sendText(initialPrompt);
      } else if (opts?.isReconnect || Date.now() - lastGreetingSentAt < 90_000 || !settings.voiceGreetings) {
        // Auto-reconnect (Google closes Live sessions after ~7-10 min) or a
        // rapid re-wake or voice-greetings-off (the default): do NOT speak.
        // Users read the repeated "Hey, I'm here!" + fresh session as "SERA
        // restarted"/"SERA keeps interrupting". Just sit silently in
        // listening state — the chime already played, the mic is live, and
        // the next thing they say is processed normally.
        console.log('[SERA] Silent wake — no greeting, listening (voiceGreetings=' +
          String(settings.voiceGreetings !== false) + ')');
      } else {
        // Opt-in greeting (Settings → PERSONA → Voice Greetings)
        console.log('[SERA] Voice wake — prompting Sera for a natural spoken greeting');
        lastGreetingSentAt = Date.now();
        session.sendText(`Hey! Someone just called your name. Please say a short, warm, natural greeting to let them know you're listening.`);
      }
    } catch (err) {
      console.error(`[SERA] ${startAttemptId} Hook: session.connect() error:`, err);
      isStartingSessionRef.current = false;
      stateManagerRef.current.transitionTo('idle', 'Ready for wake word');
    } finally {
      isStartingSessionRef.current = false;
    }
  }, [state, settings, updateSettings, runMode]);

  // Keep the stable ref current after startSession re-creation.
  useEffect(() => {
    startSessionRef.current = startSession;
  }, [startSession]);

  // Stop session
  const stopSession = useCallback(() => {
    console.log('[SERA] 🛑 User clicked microphone OFF - stopping session');
    reconnectRequestedRef.current = false;
    reconnectAttemptsRef.current = 0;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // v1.6.10: a dying session kills its screen-share feed server-side;
    // clear the badge immediately so it never outlives the session.
    setIsScreenSharing(false);
    if (liveSessionRef.current) {
      liveSessionRef.current.disconnect();
      liveSessionRef.current = null;
    } else {
      stateManagerRef.current.transitionTo('disconnected', 'User stopped session');
    }
  }, []);

  // Toggle session on/off — a click ALWAYS wakes her from full sleep
  const toggleSession = useCallback(() => {
    if (state === 'disconnected' || state === 'error') {
      wakeFromSleep();
      startSession();
    } else {
      stopSession();
    }
  }, [state, startSession, stopSession, wakeFromSleep]);

  // Interruption trigger
  const interrupt = useCallback(() => {
    if (liveSessionRef.current) {
      liveSessionRef.current.interrupt();
    }
  }, []);

  // Send text message (only if already connected)
  const sendTextMessage = useCallback((text: string) => {
    if (liveSessionRef.current) {
      liveSessionRef.current.sendText(text);
    }
  }, []);

  // v1.6.10: stop the live screen share from the UI (LIVE badge button).
  // The server confirms via screen_share_state; optimistic clear first so
  // the badge reacts instantly even on a laggy link.
  const stopScreenShare = useCallback(() => {
    setIsScreenSharing(false);
    liveSessionRef.current?.stopScreenShare?.();
  }, []);

  // Send text message — auto-wakes Sera first if she's offline, then delivers the message.
  // Typing to her ALWAYS ends full sleep — that is the "when I need you I will ask" path.
  const sendTextOrWake = useCallback((text: string) => {
    wakeFromSleep();
    // v1.7.0: sharing with continuous Screen Vision OFF? Attach ONE fresh
    // frame right before the question — the frame rides the live socket
    // (ordered before the text) or buffers for the session-ready injection,
    // so "what is on my screen?" still sees the CURRENT screen.
    const share = screenShareRef.current;
    if ((share.phase === 'active' || share.phase === 'paused') && !share.visionMode) {
      void share.attachFrameOnce();
    }
    if (liveSessionRef.current?.getIsConnected()) {
      // Already live — send directly
      liveSessionRef.current.sendText(text);
    } else {
      // Sera is sleeping — wake her up WITH the message as the initial prompt
      void startSession(text);
    }
  }, [startSession, wakeFromSleep]);

  // Clear transcripts
  const clearHistory = useCallback(() => {
    setTranscripts([]);
    setToolLogs([]);
    dismissBrowserAction();
  }, [dismissBrowserAction]);

  return {
    state,
    errorMessage,
    settings,
    updateSettings,
    transcripts,
    toolLogs,
    activeBrowserAction,
    dismissBrowserAction,
    diagnostics,
    visualizerData,
    speakerObservation,
    startSession,
    stopSession,
    toggleSession,
    interrupt,
    sendTextMessage,
    sendTextOrWake,
    clearHistory,
    isScreenSharing,
    stopScreenShare,
    screenShare,
    isConnected: state === 'listening' || state === 'speaking',
    sleepMode,
    enterSleepMode,
    wakeFromSleep,
  };
}







