import { useEffect, useRef, useState, useCallback } from 'react';
import { LocalWakeEngine } from '../audio/LocalWakeEngine';

interface UseWakeWordOptions {
  enabled?: boolean;
  onWake: (capturedPrompt?: string) => void;
}

export interface WakeDiagnostics {
  engineStatus: string;
  micDevice: string | null;
  micSignal: boolean;
  sapiState: string | null;
  latestTranscript: string | null;
  audioEvents: number;
  transcripts: number;
  ipcTranscripts: number;
  wakeMatches: number;
  latestCommand: string | null;
}

export function useWakeWord({ enabled = true, onWake }: UseWakeWordOptions) {
  const [isListeningForWake, setIsListeningForWake] = useState(false);
  const [isSupported] = useState(true);
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null);
  const [speechStatus, setSpeechStatus] = useState('STARTED');
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [wakeDiagnostics, setWakeDiagnostics] = useState<WakeDiagnostics>({
    engineStatus: 'STARTING',
    micDevice: null,
    micSignal: false,
    sapiState: null,
    latestTranscript: null,
    audioEvents: 0,
    transcripts: 0,
    ipcTranscripts: 0,
    wakeMatches: 0,
    latestCommand: null,
  });

  const engineRef = useRef<LocalWakeEngine | null>(null);
  const onWakeRef = useRef(onWake);
  const shouldListenRef = useRef(enabled);

  useEffect(() => {
    onWakeRef.current = onWake;
  }, [onWake]);

  useEffect(() => {
    shouldListenRef.current = enabled;
  }, [enabled]);

  const requestPermission = useCallback(async () => {
    console.log('[MIC_PERMISSION_REQUESTED]');
    const engine = engineRef.current ?? new LocalWakeEngine();
    engineRef.current = engine;
    const granted = await engine.requestPermission();
    setPermissionGranted(granted);
    if (granted && shouldListenRef.current) {
      await engine.start();
    }
    return granted;
  }, []);

  // Main lifecycle controller
  useEffect(() => {
    if (!enabled) {
      engineRef.current?.stop();
      setIsListeningForWake(false);
      return;
    }

    const engine = new LocalWakeEngine({
      onWake: (capturedPrompt) => {
        if (!shouldListenRef.current) return;
        setWakeDiagnostics((prev) => ({
          ...prev,
          wakeMatches: prev.wakeMatches + 1,
          latestCommand: capturedPrompt ?? null,
        }));
        console.log(`[WAKE_MATCH] matched=true command="${capturedPrompt ?? ''}" [LOCAL_WAKE_ACTIVE]`);
        onWakeRef.current(capturedPrompt);
      },

      onTranscript: (transcript) => {
        setWakeDiagnostics((prev) => ({
          ...prev,
          latestTranscript: transcript,
          transcripts: prev.transcripts + 1,
        }));
        console.log(`[TRANSCRIPT] "${transcript}"`);
      },

      onError: (error) => {
        console.error('[WAKE_ENGINE_ERROR]', error.message);
        setSpeechError(error.message);
        setSpeechStatus('ERROR');
      },

      onStatus: (status) => {
        setSpeechStatus(status);
        if (status === 'READY' || status === 'STARTED') {
          setSpeechError(null);
          setPermissionGranted(true);
          console.log('[LOCAL_WAKE_ACTIVE]');
        }
      },

      onDiagnostic: (diagnostic) => {
        setWakeDiagnostics((prev) => ({
          ...prev,
          audioEvents:
            diagnostic.level !== undefined ? prev.audioEvents + 1 : prev.audioEvents,
          ipcTranscripts:
            diagnostic.event === 'IPC_TRANSCRIPT'
              ? prev.ipcTranscripts + 1
              : prev.ipcTranscripts,
          micSignal:
            typeof diagnostic.signal === 'string'
              ? diagnostic.signal.toLowerCase() === 'true'
              : (diagnostic.signal ?? prev.micSignal),
          micDevice:
            diagnostic.event === 'MIC_DEVICE_SELECTED'
              ? (diagnostic.name ?? prev.micDevice)
              : prev.micDevice,
          sapiState:
            diagnostic.event === 'SAPI_AUDIO_STATE'
              ? (diagnostic.state ?? prev.sapiState)
              : prev.sapiState,
        }));
        if (diagnostic.event && diagnostic.event !== 'AUDIO_LEVEL') {
          console.log(
            `[DIAGNOSTIC] ${diagnostic.event}${diagnostic.message ? ': ' + diagnostic.message : ''}`,
          );
        }
      },

      onStateChange: (state) => {
        setWakeDiagnostics((prev) => ({ ...prev, engineStatus: state }));
        const listening =
          state === 'LISTENING' ||
          state === 'WAKE_DETECTED' ||
          state === 'COMMAND_LISTENING';
        setIsListeningForWake(listening);
      },
    });

    engineRef.current = engine;

    // Start directly — NO requestPermission() first!
    // SpeechRecognition handles its own mic access. Calling getUserMedia before
    // SpeechRecognition.start() causes a mic driver conflict and the blinking icon.
    //
    // The IIFE was previously a `void (async () => { ... })()` without any
    // try/catch. If `engine.start()` threw (e.g. SpeechRecognition not
    // implemented in the current browser, or mic permission denied), the
    // rejection would surface as an unhandled promise rejection in the
    // console — masking the real cause. Wrap it so errors are surfaced
    // through the same channel as other engine errors.
    void (async () => {
      console.log('[WAKE_ENGINE_INITIALIZING]');
      try {
        const started = await engine.start();
        if (started) {
          setPermissionGranted(true);
        } else {
          console.warn('[WAKE_ENGINE_START_FAILED] Wake word engine could not start');
          setPermissionGranted(false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[WAKE_ENGINE_START_ERROR]', message);
        setSpeechError(message);
        setSpeechStatus('ERROR');
        setPermissionGranted(false);
      }
    })();

    return () => {
      engine.stop();
      engineRef.current = null;
      setIsListeningForWake(false);
    };
  }, [enabled]);

  return {
    isListeningForWake,
    isSupported,
    permissionGranted,
    requestPermission,
    speechStatus,
    speechError,
    wakeDiagnostics,
  };
}
