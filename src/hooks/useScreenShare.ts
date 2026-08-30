/**
 * v1.7.0 — React orchestration for browser screen share + screen vision.
 *
 * Owns the BrowserScreenShareController (capture pipeline) and the
 * ScreenVisionChannel (transport to the server), keeps their states
 * merged for the UI, persists the vision-mode preference, and provides
 * the one-shot "look NOW" path used when the user asks a screen question
 * with continuous vision turned off.
 *
 * Design rule: a transport failure NEVER kills the local share. The
 * preview keeps running, frames queue, and the channel reconnects — the
 * user experiences a few seconds of "connecting", not a dead feature.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStableAuthorizationId } from '../authorization/AuthorizationIdentity';
import {
  BrowserScreenShareController,
  BrowserScreenShareState,
  BrowserScreenShareStats,
  CapturedScreenFrame,
  ScreenShareError,
  ScreenShareSourceKind,
} from '../vision/browserScreenShare';
import { ScreenVisionChannel, ScreenVisionChannelState, OCR_INTERVAL_DEFAULT_MS } from '../vision/screenVisionChannel';

/** Minimal structural surface the hook needs from a live session. */
interface ScreenFrameCarrier {
  getIsConnected(): boolean;
  sendScreenFrame?: (frame: CapturedScreenFrame) => void;
}

const VISION_MODE_STORAGE_KEY = 'sera_screen_vision_mode_v1';
/** v1.8.1 — persisted OCR re-scan interval preference (ms). */
const OCR_INTERVAL_STORAGE_KEY = 'sera_screen_ocr_interval_v1';
const OCR_INTERVAL_MIN_MS = 2_000;
const OCR_INTERVAL_MAX_MS = 120_000;

/** Reads + clamps the persisted OCR interval; 8s default when absent. */
function readPersistedOcrInterval(): number {
  try {
    const saved = Number(localStorage.getItem(OCR_INTERVAL_STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= OCR_INTERVAL_MIN_MS && saved <= OCR_INTERVAL_MAX_MS) {
      return Math.round(saved);
    }
  } catch { /* storage blocked — default applies */ }
  return OCR_INTERVAL_DEFAULT_MS;
}

export type ScreenSharePhase = 'idle' | 'requesting' | 'active' | 'paused';

export interface UseScreenShareResult {
  phase: ScreenSharePhase;
  visionMode: boolean;
  source: ScreenShareSourceKind;
  sourceLabel: string;
  error: { kind: string; message: string } | null;
  stats: BrowserScreenShareStats;
  channelState: ScreenVisionChannelState | null;
  /** Server-confirmed: frames are reaching a live SERA session right now. */
  streaming: boolean;
  /** Local online/offline mode — screen vision needs the Gemini engine. */
  visionAvailable: boolean;
  stream: MediaStream | null;
  start: () => Promise<boolean>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  switchSource: () => Promise<boolean>;
  setVisionMode: (enabled: boolean) => void;
  /** v1.8.1 — live OCR re-scan interval (ms), adjustable while sharing. */
  ocrIntervalMs: number;
  setOcrInterval: (ms: number) => void;
  /** Fresh single frame for an about-to-be-asked question (vision OFF). */
  attachFrameOnce: () => Promise<boolean>;
  dismissError: () => void;
}

interface UseScreenShareOptions {
  /** Current engine mode — screen vision requires 'online' (Gemini). */
  getRunMode?: () => 'online' | 'local';
  /** Live session accessor for the ordered one-shot frame path. */
  getLiveSession?: () => ScreenFrameCarrier | null;
}

export function useScreenShare(options: UseScreenShareOptions = {}): UseScreenShareResult {
  const [phase, setPhase] = useState<ScreenSharePhase>('idle');
  const [visionMode, setVisionModeState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(VISION_MODE_STORAGE_KEY);
      if (saved === 'false') return false;
    } catch { /* storage blocked — default ON */ }
    return true;
  });
  // v1.8.1 — OCR interval preference survives page reloads / app restarts.
  const [ocrIntervalMs, setOcrIntervalMs] = useState<number>(() => readPersistedOcrInterval());
  const [shareState, setShareState] = useState<BrowserScreenShareState>({
    active: false,
    paused: false,
    source: 'unknown',
    label: '',
  });
  const [error, setError] = useState<{ kind: string; message: string } | null>(null);
  const [stats, setStats] = useState<BrowserScreenShareStats>({
    framesSent: 0,
    framesSkipped: 0,
    lastFrameBytes: 0,
    lastFrameAt: null,
    startedAt: null,
  });
  const [channelState, setChannelState] = useState<ScreenVisionChannelState | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const controllerRef = useRef<BrowserScreenShareController | null>(null);
  const channelRef = useRef<ScreenVisionChannel | null>(null);
  const visionModeRef = useRef(visionMode);
  const ocrIntervalRef = useRef(ocrIntervalMs);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    visionModeRef.current = visionMode;
  }, [visionMode]);

  useEffect(() => {
    ocrIntervalRef.current = ocrIntervalMs;
  }, [ocrIntervalMs]);

  // Light periodic stats mirror (controller stats are mutable objects;
  // a 1s mirror keeps the UI honest without a re-render per frame).
  useEffect(() => {
    statsTimerRef.current = setInterval(() => {
      const controller = controllerRef.current;
      if (!controller) return;
      setStats((prev) => {
        const next = controller.getStats();
        if (
          prev.framesSent === next.framesSent &&
          prev.framesSkipped === next.framesSkipped &&
          prev.lastFrameBytes === next.lastFrameBytes &&
          prev.lastFrameAt === next.lastFrameAt
        ) {
          return prev;
        }
        return next;
      });
    }, 1000);
    return () => {
      if (statsTimerRef.current) clearInterval(statsTimerRef.current);
    };
  }, []);

  // Stable session-accessor: reads the CURRENT session at call time.
  // (useAssistant passes a ref-reading callback so this never goes stale.)
  const getLiveSession = options.getLiveSession;

  const ensureChannel = useCallback((): ScreenVisionChannel => {
    if (channelRef.current) return channelRef.current;
    const channel = new ScreenVisionChannel((event) => {
      if (event.type === 'error') {
        setError({ kind: 'channel', message: event.error });
      } else {
        setChannelState(event.state);
      }
    });
    channelRef.current = channel;
    return channel;
  }, []);

  const start = useCallback(async (): Promise<boolean> => {
    if (controllerRef.current?.isActive) return true;
    setPhase('requesting');
    setError(null);

    const controller = new BrowserScreenShareController({
      onFrame: (frame: CapturedScreenFrame) => {
        // Continuous frames flow only when vision mode is ON (privacy:
        // with vision OFF nothing leaves the machine unless asked).
        if (!visionModeRef.current) return;
        channelRef.current?.sendFrame(frame);
      },
      onStateChange: (state, reason) => {
        setShareState(state);
        if (!state.active) {
          // Share ended (stop / track-ended / switched) — mirror to server.
          channelRef.current?.stop();
          channelRef.current = null;
          setPhase('idle');
          setStream(null);
        } else {
          setPhase(state.paused ? 'paused' : 'active');
          setStream(controllerRef.current?.getStream() ?? null);
        }
        void reason;
      },
      onError: (err: ScreenShareError) => {
        setError({ kind: err.kind, message: err.message });
        if (!controllerRef.current?.isActive) {
          setPhase('idle');
        }
      },
    });
    controllerRef.current = controller;

    try {
      await controller.start();
    } catch {
      controllerRef.current = null;
      setPhase('idle');
      return false; // typed error already surfaced via onError
    }

    const channel = ensureChannel();
    const authorizationId =
      typeof window !== 'undefined' ? getStableAuthorizationId() : 'anonymous';
    channel.start(authorizationId, {
      visionMode: visionModeRef.current,
      intervalMs: 2500,
      source: controller.getState().source,
      ocrIntervalMs: ocrIntervalRef.current,
    });
    setStream(controller.getStream());
    setPhase('active');
    return true;
  }, [ensureChannel]);

  const pause = useCallback(() => {
    controllerRef.current?.pause();
    channelRef.current?.setPaused(true);
  }, []);

  const resume = useCallback(() => {
    controllerRef.current?.resume();
    channelRef.current?.setPaused(false);
  }, []);

  const stop = useCallback(() => {
    controllerRef.current?.stop('user-stop');
    // onStateChange mirrors the channel stop; belt-and-braces local clear:
    if (!controllerRef.current?.isActive) {
      channelRef.current?.stop();
      channelRef.current = null;
    }
    setPhase('idle');
    setStream(null);
  }, []);

  const switchSource = useCallback(async (): Promise<boolean> => {
    const controller = controllerRef.current;
    if (!controller?.isActive) return false;
    try {
      await controller.switchSource();
      // New surface → restart the server-side registration cleanly.
      const channel = ensureChannel();
      const authorizationId =
        typeof window !== 'undefined' ? getStableAuthorizationId() : 'anonymous';
      channel.start(authorizationId, {
        visionMode: visionModeRef.current,
        intervalMs: 2500,
        source: controller.getState().source,
        ocrIntervalMs: ocrIntervalRef.current,
      });
      setStream(controller.getStream());
      return true;
    } catch {
      // switchSource failure (e.g. user cancelled the picker) keeps the
      // OLD share alive — controller.start() only tears down on success.
      return false;
    }
  }, [ensureChannel]);

  const setVisionMode = useCallback((enabled: boolean) => {
    setVisionModeState(enabled);
    visionModeRef.current = enabled;
    try {
      localStorage.setItem(VISION_MODE_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch { /* storage blocked — preference stays in-memory */ }
    channelRef.current?.setVisionMode(enabled);
  }, []);

  // v1.8.1 — live OCR interval change: clamped, persisted, applied live
  // when a share is running (server confirms via screen_channel_state).
  const setOcrInterval = useCallback((ms: number) => {
    const clamped =
      typeof ms === 'number' && Number.isFinite(ms)
        ? Math.min(OCR_INTERVAL_MAX_MS, Math.max(OCR_INTERVAL_MIN_MS, Math.round(ms)))
        : OCR_INTERVAL_DEFAULT_MS;
    setOcrIntervalMs(clamped);
    ocrIntervalRef.current = clamped;
    try {
      localStorage.setItem(OCR_INTERVAL_STORAGE_KEY, String(clamped));
    } catch { /* storage blocked — preference stays in-memory */ }
    channelRef.current?.setOcrInterval(clamped);
  }, []);

  const attachFrameOnce = useCallback(async (): Promise<boolean> => {
    const controller = controllerRef.current;
    if (!controller?.isActive) return false;
    // Ordered path first: the live session socket guarantees the frame
    // lands BEFORE the question text on the same connection.
    const session = getLiveSession?.();
    if (session?.getIsConnected()) {
      const frame = controller.captureFrameNow();
      if (frame && typeof session.sendScreenFrame === 'function') {
        session.sendScreenFrame(frame);
        return true;
      }
    }
    // No live socket (or it cannot carry frames): one-shot over the
    // screen channel — the server buffers it and injects it the moment
    // the next session is ready, before the queued question flushes.
    const frame = controller.captureFrameNow();
    if (!frame) return false;
    channelRef.current?.sendFrame(frame, { oneShot: true });
    return true;
  }, [getLiveSession]);

  const dismissError = useCallback(() => setError(null), []);

  // Kill the share when the component tree unmounts (tab close counts).
  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
      channelRef.current?.stop();
      channelRef.current = null;
    };
  }, []);

  const getRunModeFn = options.getRunMode;
  const runMode = useMemo(() => getRunModeFn?.() ?? 'online', [getRunModeFn]);

  // Stable result object: identity changes ONLY when real state changes,
  // so React.memo'd consumers (ScreenShareDock) stay out of the 30fps
  // visualizer re-render path entirely.
  const result = useMemo<UseScreenShareResult>(() => ({
    phase,
    visionMode,
    source: shareState.source,
    sourceLabel: shareState.label,
    error,
    stats,
    channelState,
    streaming: channelState?.streaming === true,
    visionAvailable: runMode !== 'local',
    stream,
    start,
    pause,
    resume,
    stop,
    switchSource,
    setVisionMode,
    ocrIntervalMs,
    setOcrInterval,
    attachFrameOnce,
    dismissError,
  }), [
    phase,
    visionMode,
    shareState,
    error,
    stats,
    channelState,
    runMode,
    stream,
    start,
    pause,
    resume,
    stop,
    switchSource,
    setVisionMode,
    ocrIntervalMs,
    setOcrInterval,
    attachFrameOnce,
    dismissError,
  ]);

  return result;
}
