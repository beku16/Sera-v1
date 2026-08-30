declare global {
  interface Window {
    seraDesktop?: {
      isDesktop: boolean;
      openExternal: (url: string) => Promise<void>;
      clipboardWrite?: (text: string) => Promise<boolean>;
      /** Quit the desktop app AND stop the SERA server process. */
      quitApp?: () => Promise<void>;
      startLocalSpeech: () => Promise<{ state: string; pid: number | null; exitCode: number | null } | boolean>;
      stopLocalSpeech: () => Promise<boolean>;
      getLocalSpeechState: () => Promise<{ state: string; pid: number | null; exitCode: number | null; owners: number }>;
      getAutoStart?: () => Promise<boolean>;
      setAutoStart?: (enable: boolean) => Promise<boolean>;
      showNotification?: (title: string, body: string) => Promise<void>;
      minimizeToTray?: () => Promise<void>;
      onTrayAction?: (listener: (action: string) => void) => () => void;
      onLocalSpeechTranscript: (listener: (payload: { text?: string; confidence?: number; mainTranscriptCount?: number; preloadTranscriptCount?: number }) => void) => () => void;
      onLocalSpeechStatus: (listener: (payload: { status?: string; message?: string }) => void) => () => void;
      onLocalSpeechError: (listener: (payload: { message?: string }) => void) => () => void;
      onLocalSpeechDiagnostic: (listener: (payload: { type?: string; event?: string; name?: string; level?: number; signal?: boolean | string; state?: string; message?: string }) => void) => () => void;
    };
  }
}

export {};
export type AssistantStateType =
  | 'disconnected'
  | 'connecting'
  | 'idle'
  | 'wake_word_detected'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'error';

export interface AudioDiagnosticsInfo {
  updatedAt?: number;
  inputSampleRate: number;
  outputSampleRate: number;
  audioContextState: string;
  outputContextState?: string;
  isOutputPlaying?: boolean;
  isStreaming: boolean;
  noiseFloorDb: number;
  inputRmsDb: number;
  snrDb: number;
  isSpeechDetected: boolean;
  speechProbability: number;
  processingLatencyMs: number;
  constraintsSupported: {
    echoCancellation: boolean;
    autoGainControl: boolean;
  };
}

export interface AudioVisualizerData {
  micLevel: number;       // 0.0 to 1.0
  speakerLevel: number;   // 0.0 to 1.0
  frequencies: Uint8Array;
}

export type VoiceName = 'Aoede' | 'Kore' | 'Zephyr' | 'Puck' | 'Fenrir' | 'Charon';

export type ColorPaletteId =
  | 'cosmic-indigo'
  | 'cyber-emerald'
  | 'solar-flare'
  | 'amethyst-nebula'
  | 'glacier-ice'
  | 'supernova-gold'
  | 'phantom-crimson'
  | 'custom';

export interface AssistantSettings {
  voice: VoiceName;
  inputGain: number;      // 0.5 to 2.0
  outputVolume: number;   // 0.0 to 1.0
  inputDeviceId?: string; // Specific microphone deviceId or 'default'
  outputDeviceId?: string;// Specific speaker/output deviceId or 'default'
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  /** Discord-style automatic gain control for the microphone. */
  autoGainControl?: boolean;
  autoReconnect: boolean;
  enableVisualizer: boolean;
  requireToolConfirmation: boolean;
  directRedirect?: boolean;
  palette?: ColorPaletteId;
  customColor?: string;   // hex color for 'custom' palette
  themeMode?: 'dark' | 'light' | 'system';
  speakerRecognition: boolean;
  /** Dual-mode engine selector: 'online' (Gemini Live) or 'local' (Ollama, 100% offline). */
  runMode?: 'online' | 'local';
  /** Ollama model override for Local Mode. */
  localModel?: string;
  /** Set true after the startup launcher wizard completes. */
  startupComplete?: boolean;
  /**
   * v1.8.4: the app version the wizard was last completed on. The wizard
   * re-shows ONCE per new version — localStorage survives reinstalls
   * (Electron userData is keyed by app name, not install folder), so a
   * "fresh" install used to inherit startupComplete=true and the mode
   * selection + setup instructions never appeared.
   */
  startupCompletedVersion?: string;
  /**
   * When true, SERA speaks a short greeting after a bare voice wake
   * ("Hey Sera" with no command). Default OFF — unprompted speech was
   * the single biggest "she keeps interrupting me" complaint.
   */
  voiceGreetings?: boolean;
  /**
   * Hands-free "Hey Sera" wake-word listener. Default ON — she hears
   * her name any time the app is idle (never while connected/sleeping).
   * Turn OFF for full manual control via the mic button.
   */
  wakeWordEnabled?: boolean;
  /** Update policy preference */
  updateBehavior?: 'ask' | 'auto_download' | 'auto_install';
  /** Last dismissed / snoozed update version to prevent notification spam */
  snoozedUpdateVersion?: string;
  /** Timestamp until when update notifications for the snoozed version are suppressed */
  snoozedUntil?: number;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'downloading'
  | 'verifying'
  | 'ready-to-install'
  | 'installing'
  | 'restarting'
  | 'error';

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  downloadUrl: string | null;
  assetName: string | null;
  assetSize: number | null;
  lastChecked: number | null;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
}

export interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo;
  progress: DownloadProgress;
  downloadedFilePath: string | null;
  errorMessage: string | null;
  safeToRestart: boolean;
}

export interface TranscriptItem {
  id: string;
  sender: 'user' | 'sera';
  text: string;
  timestamp: number;
  isPartial?: boolean;
  speakerId?: string;
  speakerName?: string;
  speakerConfidence?: 'high' | 'medium' | 'low';
}

export interface ToolCallLogItem {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'pending' | 'executing' | 'success' | 'rejected' | 'failed';
  result?: unknown;
  error?: string;
  timestamp: number;
}

export interface BrowserActionEvent {
  id: string;
  url: string;
  domain: string;
  siteName: string;
  openedDirectly: boolean;
  timestamp: number;
}

export interface PaletteActionEvent {
  id: string;
  palette: ColorPaletteId;
  timestamp: number;
}


