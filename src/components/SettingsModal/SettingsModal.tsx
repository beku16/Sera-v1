import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Volume2,
  Mic,
  Sliders,
  Check,
  Palette,
  Brain,
  Users,
  Sparkles,
  Sun,
  Moon,
  Dices,
  Copy,
  Wand2,
  Headphones,
  Play,
  Activity,
  ShieldCheck,
  RefreshCw,
  KeyRound,
  Boxes,
  Monitor,
} from 'lucide-react';
import { AssistantSettings, ColorPaletteId, VoiceName } from '../../types';
import { PREDEFINED_PALETTES, getPaletteConfig } from '../../config/palettes';
import { APP_CONFIG } from '../../config/config';
import { MemorySettingsTab } from './MemorySettingsTab';
import { SpeakerRecognitionTab } from './SpeakerRecognitionTab';
import { ApiKeySettingsTab } from './ApiKeySettingsTab';
import { ModelsProvidersTab } from './ModelsProvidersTab';
import { MyPcTab } from './MyPcTab';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AssistantSettings;
  onUpdateSettings: (newSettings: Partial<AssistantSettings>) => void;
  /** Tab the modal opens on (voice console shortcut opens MIC & SPEAKERS). */
  initialTab?: 'atmosphere' | 'audio' | 'voice' | 'mypc' | 'memory' | 'speakers' | 'keys' | 'models';
  /** v1.8.4: reopens the startup wizard (mode selection + setup instructions). */
  onOpenSetupWizard?: () => void;
  /** Opens the secure uninstallation modal */
  onOpenUninstall?: () => void;
}

interface MediaDeviceInfoItem {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

function hexToRgbValues(hex: string): [number, number, number] {
  let value = hex.replace('#', '').trim();
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (value.length !== 6) return [255, 0, 255];
  return [
    parseInt(value.slice(0, 2), 16) || 0,
    parseInt(value.slice(2, 4), 16) || 0,
    parseInt(value.slice(4, 6), 16) || 0,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n || 0)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const CURATED_PRESETS = [
  { name: 'Neon Ruby', hex: '#ff0055' },
  { name: 'Solar Crimson', hex: '#ff3300' },
  { name: 'Amber Sun', hex: '#ff9900' },
  { name: 'Matrix Emerald', hex: '#00ff88' },
  { name: 'Cyber Cyan', hex: '#00e5ff' },
  { name: 'Sapphire', hex: '#0066ff' },
  { name: 'Electric Violet', hex: '#a855f7' },
  { name: 'Hot Magenta', hex: '#ff00aa' },
  { name: 'Acid Lime', hex: '#a3e635' },
  { name: 'Ice Crystal', hex: '#38bdf8' },
  { name: 'Rose Gold', hex: '#fb7185' },
  { name: 'Pure Stellar', hex: '#ffffff' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  initialTab = 'atmosphere',
  onOpenSetupWizard,
  onOpenUninstall,
}) => {
  const [activeTab, setActiveTab] = useState<'atmosphere' | 'audio' | 'voice' | 'mypc' | 'memory' | 'speakers' | 'keys' | 'models'>(initialTab);
  const [copied, setCopied] = useState(false);

  // Every open honors the requested tab — e.g. the voice deck's sliders
  // button jumps straight to MIC & SPEAKERS.
  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [isOpen, initialTab]);

  // Audio Device Lists
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfoItem[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfoItem[]>([]);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [isPlayingTestChime, setIsPlayingTestChime] = useState(false);
  // Unified Discord-style mic test: idle → recording (live meter + 5s
  // countdown) → playing (your own voice) → idle. ONE button does what
  // users expect from "Test Mic": they HEAR themselves.
  const [micTestPhase, setMicTestPhase] = useState<'idle' | 'recording' | 'playing'>('idle');
  const [micTestCountdown, setMicTestCountdown] = useState(0);

  const micStreamRef = useRef<MediaStream | null>(null);
  const micAnimRef = useRef<number | null>(null);
  // Discord "Let Me Hear" — continuous LIVE mic→speaker monitor so you hear
  // yourself in real time (no 5s record step). Mutually exclusive with the
  // record-and-playback test.
  const [liveMonitorOn, setLiveMonitorOn] = useState(false);
  const liveMonitorStreamRef = useRef<MediaStream | null>(null);
  const liveMonitorCtxRef = useRef<AudioContext | null>(null);
  const liveMonitorAnimRef = useRef<number | null>(null);
  const liveMonitorGainRef = useRef<GainNode | null>(null);
  // Track AudioContexts created during mic test / chime playback so they can
  // be closed on stop / unmount. Browsers cap live AudioContexts at ~6 per
  // tab; previously each test created a new one and never closed it, so a
  // user opening/closing the settings modal a handful of times would hit
  // the limit and silently break all subsequent audio (including Sera's
  // own mic / playback).
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const chimeAudioCtxRef = useRef<AudioContext | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voicePlaybackRef = useRef<HTMLAudioElement | null>(null);
  const voiceCountdownTimerRef = useRef<number | null>(null);

  /** Microphone constraints honoring every Discord-style audio setting. */
  const buildMicConstraints = (): MediaStreamConstraints => {
    const audio: MediaTrackConstraints = {
      noiseSuppression: settings.noiseSuppression ?? true,
      echoCancellation: settings.echoCancellation ?? true,
      autoGainControl: settings.autoGainControl ?? true,
    };
    if (settings.inputDeviceId && settings.inputDeviceId !== 'default') {
      audio.deviceId = { exact: settings.inputDeviceId };
    }
    return { audio };
  };

  // Enumerate Audio Devices
  const refreshDevices = async () => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      const devices = await navigator.mediaDevices.enumerateDevices();

      const inputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d, index) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${index + 1}`,
          kind: d.kind,
        }));

      const outputs = devices
        .filter((d) => d.kind === 'audiooutput')
        .map((d, index) => ({
          deviceId: d.deviceId,
          label: d.label || `Speaker / Output ${index + 1}`,
          kind: d.kind,
        }));

      setInputDevices(inputs);
      setOutputDevices(outputs);
    } catch (err) {
      console.warn('[SERA] Failed to enumerate audio devices:', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void refreshDevices();
    } else {
      stopMicLoopback();
      stopLiveMonitor();
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      stopMicLoopback();
      stopLiveMonitor();
      // Defensive: also close any lingering chime context in case the user
      // closed the modal mid-chime.
      if (chimeAudioCtxRef.current) {
        try { void chimeAudioCtxRef.current.close(); } catch {}
        chimeAudioCtxRef.current = null;
      }
    };
  }, []);

  /**
   * Discord-style "Let Me Hear" — LIVE continuous monitoring. The mic opens
   * with the EXACT same constraints your sessions use (noise suppression,
   * echo cancellation, auto gain, chosen input device) and routes straight
   * to your chosen output device with zero recording step. The INPUT GAIN
   * slider shapes what you hear in real time, just like Discord's
   * "Microphone Volume".
   */
  const stopLiveMonitor = () => {
    if (liveMonitorAnimRef.current) {
      cancelAnimationFrame(liveMonitorAnimRef.current);
      liveMonitorAnimRef.current = null;
    }
    liveMonitorGainRef.current = null;
    if (liveMonitorStreamRef.current) {
      liveMonitorStreamRef.current.getTracks().forEach((t) => t.stop());
      liveMonitorStreamRef.current = null;
    }
    if (liveMonitorCtxRef.current) {
      try { void liveMonitorCtxRef.current.close(); } catch {}
      liveMonitorCtxRef.current = null;
    }
    setLiveMonitorOn(false);
    if (micTestPhase !== 'recording' && micTestPhase !== 'playing') setMicTestLevel(0);
  };

  const startLiveMonitor = async () => {
    if (liveMonitorOn) return;
    stopMicLoopback(); // live monitor and the 5s test are exclusive
    try {
      const stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints());
      liveMonitorStreamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx({ latencyHint: 'interactive' });
      liveMonitorCtxRef.current = ctx;
      if (settings.outputDeviceId && settings.outputDeviceId !== 'default' && 'setSinkId' in ctx) {
        try {
          await (ctx as any).setSinkId(settings.outputDeviceId);
        } catch (sinkErr) {
          console.warn('[SERA] Live monitor setSinkId failed (staying on default output):', sinkErr);
        }
      }
      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = Math.min(2, Math.max(0, settings.inputGain || 1));
      liveMonitorGainRef.current = gain;
      source.connect(gain);
      gain.connect(ctx.destination);
      // Same live meter pipeline the 5s test uses.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setMicTestLevel(Math.min(100, Math.round((avg / 128) * 100)));
        liveMonitorAnimRef.current = requestAnimationFrame(updateMeter);
      };
      liveMonitorAnimRef.current = requestAnimationFrame(updateMeter);
      setLiveMonitorOn(true);
    } catch (err) {
      console.warn('[SERA] Live monitor failed:', err);
      stopLiveMonitor();
    }
  };

  // Moving the INPUT GAIN slider while live monitoring retunes the monitor
  // gain instantly — no restart needed.
  useEffect(() => {
    if (liveMonitorGainRef.current) {
      try { liveMonitorGainRef.current.gain.value = Math.min(2, Math.max(0, settings.inputGain || 1)); } catch {}
    }
  }, [settings.inputGain]);

  /** Full stop of the unified mic loopback test (any phase). */
  const stopMicLoopback = () => {
    if (voiceCountdownTimerRef.current !== null) {
      window.clearInterval(voiceCountdownTimerRef.current);
      voiceCountdownTimerRef.current = null;
    }
    try {
      if (voiceRecorderRef.current?.state === 'recording') voiceRecorderRef.current.stop();
    } catch { /* best-effort */ }
    voiceRecorderRef.current = null;
    if (voicePlaybackRef.current) {
      try { voicePlaybackRef.current.pause(); } catch { /* best-effort */ }
      voicePlaybackRef.current = null;
    }
    if (micAnimRef.current) {
      cancelAnimationFrame(micAnimRef.current);
      micAnimRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (micAudioCtxRef.current) {
      // Close the AudioContext created for the mic test to free the browser's
      // limited AudioContext slot.
      try { void micAudioCtxRef.current.close(); } catch {}
      micAudioCtxRef.current = null;
    }
    setMicTestPhase('idle');
    setMicTestCountdown(0);
    setMicTestLevel(0);
  };

  /**
   * THE mic test — one button, the full Discord "Let's Check Mic" flow:
   * click → opens the mic with the EXACT constraints your sessions use
   * (noise suppression, echo cancellation, auto gain, chosen device),
   * shows a live level meter while recording 5 seconds of your voice,
   * then plays the recording back through your selected output device.
   * That is how you HEAR your own voice exactly as SERA hears it.
   *
   * Click again while recording → skip to playback immediately.
   * Click while playing → stop everything.
   */
  const toggleMicLoopback = async () => {
    stopLiveMonitor(); // the two mic tools are mutually exclusive
    if (micTestPhase === 'recording') {
      // Skip straight to playback.
      try { voiceRecorderRef.current?.stop(); } catch { /* best-effort */ }
      return;
    }
    if (micTestPhase === 'playing') {
      stopMicLoopback();
      return;
    }
    try {
      stopMicLoopback();
      const stream = await navigator.mediaDevices.getUserMedia(buildMicConstraints());
      micStreamRef.current = stream;

      // Live level meter while recording (same pipeline as sessions).
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (micAudioCtxRef.current) {
        try { await micAudioCtxRef.current.close(); } catch {}
        micAudioCtxRef.current = null;
      }
      const audioCtx = new AudioCtx();
      micAudioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setMicTestLevel(Math.min(100, Math.round((avg / 128) * 100)));
        micAnimRef.current = requestAnimationFrame(updateMeter);
      };
      micAnimRef.current = requestAnimationFrame(updateMeter);

      // Record 5 seconds.
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      voiceRecorderRef.current = recorder;
      setMicTestPhase('recording');
      let left = 5;
      setMicTestCountdown(left);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (voiceCountdownTimerRef.current !== null) {
          window.clearInterval(voiceCountdownTimerRef.current);
          voiceCountdownTimerRef.current = null;
        }
        // Stop the live mic + meter — from here on we only play back.
        if (micAnimRef.current) {
          cancelAnimationFrame(micAnimRef.current);
          micAnimRef.current = null;
        }
        for (const track of stream.getTracks()) {
          try { track.stop(); } catch { /* best-effort */ }
        }
        if (micAudioCtxRef.current) {
          try { void micAudioCtxRef.current.close(); } catch {}
          micAudioCtxRef.current = null;
        }
        micStreamRef.current = null;
        setMicTestLevel(0);

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) {
          setMicTestPhase('idle');
          setMicTestCountdown(0);
          return;
        }
        const url = URL.createObjectURL(blob);
        const playback = new Audio(url);
        voicePlaybackRef.current = playback;
        if (settings.outputDeviceId && settings.outputDeviceId !== 'default') {
          const routable = playback as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
          if (typeof routable.setSinkId === 'function') {
            routable.setSinkId(settings.outputDeviceId).catch(() => undefined);
          }
        }
        setMicTestPhase('playing');
        setMicTestCountdown(0);
        const finish = () => {
          URL.revokeObjectURL(url);
          voicePlaybackRef.current = null;
          setMicTestPhase('idle');
        };
        playback.onended = finish;
        playback.onerror = finish;
        void playback.play().catch(finish);
      };
      recorder.start(250);
      voiceCountdownTimerRef.current = window.setInterval(() => {
        left -= 1;
        setMicTestCountdown(Math.max(0, left));
        if (left <= 0) {
          try {
            if (voiceRecorderRef.current?.state === 'recording') voiceRecorderRef.current.stop();
          } catch { /* best-effort */ }
        }
      }, 1000);
    } catch (err) {
      console.warn('[SERA] Mic loopback test failed:', err);
      stopMicLoopback();
    }
  };

  // Play Test Sound on chosen output device
  const playTestSpeakerSound = async () => {
    if (isPlayingTestChime) return;
    setIsPlayingTestChime(true);
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      // Close any stale chime AudioContext before creating a new one.
      if (chimeAudioCtxRef.current) {
        try { await chimeAudioCtxRef.current.close(); } catch {}
        chimeAudioCtxRef.current = null;
      }
      const audioCtx = new AudioCtx();
      chimeAudioCtxRef.current = audioCtx;

      if (settings.outputDeviceId && settings.outputDeviceId !== 'default' && 'setSinkId' in audioCtx) {
        try {
          await (audioCtx as any).setSinkId(settings.outputDeviceId);
        } catch (sinkErr) {
          console.warn('[SERA] Test sound setSinkId failed:', sinkErr);
        }
      }

      const now = audioCtx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6 celestial chime

      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.09);

        const startTime = now + i * 0.09;
        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.exponentialRampToValueAtTime(0.25 * settings.outputVolume, startTime + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.45);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start(startTime);
        osc.stop(startTime + 0.5);
      });

      setTimeout(() => {
        setIsPlayingTestChime(false);
        // Close the chime AudioContext after the chime finishes so the slot
        // is freed for subsequent plays / for Sera's own playback.
        if (chimeAudioCtxRef.current) {
          try { void chimeAudioCtxRef.current.close(); } catch {}
          chimeAudioCtxRef.current = null;
        }
      }, 900);
    } catch (err) {
      console.warn('[SERA] Test chime error:', err);
      setIsPlayingTestChime(false);
      if (chimeAudioCtxRef.current) {
        try { void chimeAudioCtxRef.current.close(); } catch {}
        chimeAudioCtxRef.current = null;
      }
    }
  };

  if (!isOpen) return null;

  const currentPaletteId = settings.palette || 'solar-flare';
  const palettesList = Object.values(PREDEFINED_PALETTES);
  const customColor = settings.customColor || '#ff00aa';
  const [rVal, gVal, bVal] = hexToRgbValues(customColor);
  const customPaletteConfig = getPaletteConfig('custom', customColor);

  const tabBase = 'flex items-center justify-center gap-1.5 px-3 py-2.5 font-mono text-[11px] font-bold tracking-[0.14em] rounded-xl transition-all duration-200 select-none';
  const tabActive = 'bg-ink text-paper shadow-sm';
  const tabIdle = 'text-graphite hover:text-ink hover:bg-paper/50';

  const handleRgbChange = (channel: 'r' | 'g' | 'b', valueStr: string) => {
    let num = parseInt(valueStr, 10);
    if (isNaN(num)) num = 0;
    num = Math.max(0, Math.min(255, num));

    const newR = channel === 'r' ? num : rVal;
    const newG = channel === 'g' ? num : gVal;
    const newB = channel === 'b' ? num : bVal;

    onUpdateSettings({
      palette: 'custom' as ColorPaletteId,
      customColor: rgbToHex(newR, newG, newB),
    });
  };

  const handleRandomizeColor = () => {
    const randomHex = CURATED_PRESETS[Math.floor(Math.random() * CURATED_PRESETS.length)].hex;
    onUpdateSettings({
      palette: 'custom' as ColorPaletteId,
      customColor: randomHex,
    });
  };

  const handleCopyHex = () => {
    void navigator.clipboard.writeText(customColor);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      id="sera-settings-modal-overlay"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 select-none animate-fade-up"
    >
      {/* Semi-transparent dark backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      <div
        id="sera-settings-modal"
        className="relative z-10 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0c1018] shadow-[0_16px_64px_rgba(0,0,0,0.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-line bg-paper px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Sliders className="h-4 w-4 text-graphite" />
            <span className="font-mono text-xs font-black tracking-[0.20em] text-ink uppercase">
              CONSOLE CONFIGURATION
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-graphite transition hover:bg-panel hover:text-ink active:scale-95"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab Bar — 2×3 grid: every tab always fully visible, no clipping,
            no hidden scrollbars. Wraps gracefully at any window size. */}
        <div className="grid shrink-0 grid-cols-3 gap-1.5 border-b border-line bg-paper/60 p-2">
          <button type="button" onClick={() => setActiveTab('atmosphere')} className={`${tabBase} ${activeTab === 'atmosphere' ? tabActive : tabIdle}`}>
            <Palette className="h-3.5 w-3.5" /> ATMOSPHERE
          </button>
          <button type="button" onClick={() => setActiveTab('audio')} className={`${tabBase} ${activeTab === 'audio' ? tabActive : tabIdle}`}>
            <Volume2 className="h-3.5 w-3.5" /> MIC &amp; SPEAKERS
          </button>
          <button type="button" onClick={() => setActiveTab('voice')} className={`${tabBase} ${activeTab === 'voice' ? tabActive : tabIdle}`}>
            <Sparkles className="h-3.5 w-3.5" /> PERSONA
          </button>
          <button type="button" onClick={() => setActiveTab('mypc')} className={`${tabBase} ${activeTab === 'mypc' ? tabActive : tabIdle}`}>
            <Monitor className="h-3.5 w-3.5" /> MY PC
          </button>
          <button type="button" onClick={() => setActiveTab('memory')} className={`${tabBase} ${activeTab === 'memory' ? tabActive : tabIdle}`}>
            <Brain className="h-3.5 w-3.5" /> MEMORY
          </button>
          <button type="button" onClick={() => setActiveTab('speakers')} className={`${tabBase} ${activeTab === 'speakers' ? tabActive : tabIdle}`}>
            <Users className="h-3.5 w-3.5" /> RECOGNITION
          </button>
          <button type="button" onClick={() => setActiveTab('keys')} className={`${tabBase} ${activeTab === 'keys' ? tabActive : tabIdle}`}>
            <KeyRound className="h-3.5 w-3.5" /> API KEYS
          </button>
          <button type="button" onClick={() => setActiveTab('models')} className={`${tabBase} ${activeTab === 'models' ? tabActive : tabIdle}`}>
            <Boxes className="h-3.5 w-3.5" /> MODELS
          </button>
        </div>

        {/* Body */}
        <div className="sera-scroll flex-1 space-y-6 overflow-y-auto p-6">

          {/* ── ATMOSPHERE & COLOR TAB ── */}
          {activeTab === 'atmosphere' ? (
            <div className="space-y-6 animate-fade-up">

              {/* Interface Theme */}
              <div className="space-y-2.5">
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.16em] text-graphite">
                  <Sun className="h-3.5 w-3.5" /> INTERFACE THEME
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ themeMode: 'dark' })}
                    className={`flex items-center justify-between rounded-2xl border p-3.5 text-left transition ${
                      settings.themeMode !== 'light'
                        ? 'border-line-strong bg-paper shadow-sm ring-1 ring-ink'
                        : 'border-line bg-paper/60 hover:border-line-strong'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Moon className="h-4 w-4 text-ink" />
                      <div>
                        <span className="block font-sans text-xs font-bold text-ink">Obsidian Dark</span>
                        <span className="block font-mono text-[10px] text-graphite">Deep cosmic void</span>
                      </div>
                    </div>
                    {settings.themeMode !== 'light' && <Check className="h-4 w-4 text-ink" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ themeMode: 'light' })}
                    className={`flex items-center justify-between rounded-2xl border p-3.5 text-left transition ${
                      settings.themeMode === 'light'
                        ? 'border-line-strong bg-paper shadow-sm ring-1 ring-ink'
                        : 'border-line bg-paper/60 hover:border-line-strong'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Sun className="h-4 w-4 text-ink" />
                      <div>
                        <span className="block font-sans text-xs font-bold text-ink">Ceramic Light</span>
                        <span className="block font-mono text-[10px] text-graphite">Tactile studio console</span>
                      </div>
                    </div>
                    {settings.themeMode === 'light' && <Check className="h-4 w-4 text-ink" />}
                  </button>
                </div>
              </div>

              {/* Atmospheric Palettes & Custom Studio Card */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.16em] text-graphite">
                    <Palette className="h-3.5 w-3.5" /> ATMOSPHERIC PALETTES
                  </span>
                  <span className="font-mono text-[10px] text-graphite">
                    Active: <strong className="text-ink uppercase">{currentPaletteId}</strong>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {/* 7 Predefined Palettes */}
                  {palettesList.map((palette) => {
                    const isSelected = currentPaletteId === palette.id;
                    return (
                      <button
                        key={palette.id}
                        type="button"
                        onClick={() => onUpdateSettings({ palette: palette.id as ColorPaletteId })}
                        className={`flex flex-col gap-2 rounded-2xl border p-3 text-left transition-all ${
                          isSelected
                            ? 'border-line-strong bg-paper shadow-md ring-1 ring-ink'
                            : 'border-line bg-paper/50 hover:border-line-strong hover:bg-paper'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-sans text-xs font-bold text-ink truncate">{palette.name}</span>
                          {isSelected && <Check className="h-3.5 w-3.5 text-ink shrink-0" />}
                        </div>
                        <span
                          className="h-1.5 w-full rounded-full"
                          style={{
                            background: `linear-gradient(90deg, ${palette.lamp} 0%, ${palette.secondary || palette.lamp} 100%)`,
                            opacity: isSelected ? 1 : 0.45,
                          }}
                        />
                      </button>
                    );
                  })}

                  {/* 8th Card: Dedicated CUSTOM STUDIO card right in the grid! */}
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ palette: 'custom' as ColorPaletteId, customColor })}
                    className={`flex flex-col gap-2 rounded-2xl border p-3 text-left transition-all ${
                      currentPaletteId === 'custom'
                        ? 'border-ink bg-paper shadow-lg ring-2 ring-ink'
                        : 'border-line bg-paper/70 hover:border-line-strong hover:bg-paper'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 font-sans text-xs font-black text-ink">
                        <Wand2 className="h-3.5 w-3.5 text-pink-500" /> CUSTOM
                      </span>
                      {currentPaletteId === 'custom' ? (
                        <Check className="h-3.5 w-3.5 text-ink shrink-0" />
                      ) : (
                        <span
                          className="h-3.5 w-3.5 rounded-full shadow-sm border border-white/20"
                          style={{ background: customColor }}
                        />
                      )}
                    </div>
                    <span
                      className="h-1.5 w-full rounded-full shadow-inner"
                      style={{
                        background: `linear-gradient(90deg, ${customColor} 0%, #00e5ff 100%)`,
                      }}
                    />
                  </button>
                </div>
              </div>

              {/* ── PRO COLOR STUDIO (Always Accessible & Interactive) ── */}
              <div className="flex flex-col gap-4 rounded-3xl border border-line bg-paper p-5 shadow-xl">

                {/* Studio Header */}
                <div className="flex items-center justify-between border-b border-line/60 pb-3">
                  <div className="flex items-center gap-3">
                    <span
                      className="h-7 w-7 rounded-full border border-white/20 shadow-md transition-all duration-300"
                      style={{ background: customColor, boxShadow: `0 0 16px ${customColor}aa` }}
                    />
                    <div>
                      <span className="block font-mono text-xs font-black tracking-wider text-ink">PRO COLOR STUDIO</span>
                      <span className="block font-mono text-[9px] text-graphite">RGB Synthesizer &amp; Harmonic Shading</span>
                    </div>
                  </div>

                  {/* Toolbar */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleRandomizeColor}
                      className="flex items-center gap-1 rounded-xl border border-line bg-panel px-3 py-1.5 font-mono text-[10px] font-bold text-graphite hover:text-ink active:scale-95 shadow-sm"
                      title="Generate random aesthetic color"
                    >
                      <Dices className="h-3.5 w-3.5 text-purple-400" /> SHUFFLE
                    </button>

                    <div className="flex items-center rounded-xl border border-line bg-panel px-2.5 py-1.5 shadow-sm">
                      <span className="font-mono text-xs font-black text-ink uppercase">{customColor}</span>
                      <button
                        type="button"
                        onClick={handleCopyHex}
                        className="ml-2 text-graphite hover:text-ink"
                        title="Copy Hex Code"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      {copied && (
                        <span className="ml-1.5 font-mono text-[9px] font-bold text-emerald-500">COPIED</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* RGB Sliders Deck */}
                <div className="grid grid-cols-3 gap-3">
                  {/* Red Slider */}
                  <div className="flex flex-col gap-2 rounded-2xl border border-line/60 bg-panel/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] font-black text-red-500 tracking-wider">RED</span>
                      <input
                        type="number"
                        min="0"
                        max="255"
                        value={rVal}
                        onChange={(e) => handleRgbChange('r', e.target.value)}
                        className="w-12 rounded-lg border border-line bg-paper text-center font-mono text-xs font-black text-ink outline-none focus:border-ink"
                      />
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={rVal}
                      onChange={(e) => handleRgbChange('r', e.target.value)}
                      className="accent-red-500 h-1.5 w-full cursor-pointer"
                    />
                  </div>

                  {/* Green Slider */}
                  <div className="flex flex-col gap-2 rounded-2xl border border-line/60 bg-panel/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] font-black text-emerald-500 tracking-wider">GREEN</span>
                      <input
                        type="number"
                        min="0"
                        max="255"
                        value={gVal}
                        onChange={(e) => handleRgbChange('g', e.target.value)}
                        className="w-12 rounded-lg border border-line bg-paper text-center font-mono text-xs font-black text-ink outline-none focus:border-ink"
                      />
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={gVal}
                      onChange={(e) => handleRgbChange('g', e.target.value)}
                      className="accent-emerald-500 h-1.5 w-full cursor-pointer"
                    />
                  </div>

                  {/* Blue Slider */}
                  <div className="flex flex-col gap-2 rounded-2xl border border-line/60 bg-panel/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] font-black text-blue-500 tracking-wider">BLUE</span>
                      <input
                        type="number"
                        min="0"
                        max="255"
                        value={bVal}
                        onChange={(e) => handleRgbChange('b', e.target.value)}
                        className="w-12 rounded-lg border border-line bg-paper text-center font-mono text-xs font-black text-ink outline-none focus:border-ink"
                      />
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="255"
                      value={bVal}
                      onChange={(e) => handleRgbChange('b', e.target.value)}
                      className="accent-blue-500 h-1.5 w-full cursor-pointer"
                    />
                  </div>
                </div>

                {/* Multi-Color Harmonic Gradient Preview */}
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between font-mono text-[9px] text-graphite">
                    <span>GENERATED HARMONIC SHADING</span>
                    <span>CORE · ACCENT (+40°) · OUTER (-35°)</span>
                  </div>
                  <div
                    className="h-3 w-full rounded-full shadow-inner transition-all duration-300"
                    style={{
                      background: `linear-gradient(90deg, ${customPaletteConfig.lamp} 0%, ${customPaletteConfig.secondary} 50%, ${customPaletteConfig.tertiary || customPaletteConfig.secondary} 100%)`,
                    }}
                  />
                </div>

                {/* 12 Curated Presets */}
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line/40">
                  <span className="font-mono text-[9px] text-graphite font-bold">PRESETS:</span>
                  {CURATED_PRESETS.map((preset) => (
                    <button
                      key={preset.hex}
                      type="button"
                      onClick={() => onUpdateSettings({ palette: 'custom' as ColorPaletteId, customColor: preset.hex })}
                      className={`h-6 w-6 rounded-full border shadow-sm transition hover:scale-125 active:scale-95 ${
                        customColor.toLowerCase() === preset.hex.toLowerCase()
                          ? 'border-ink ring-2 ring-ink ring-offset-1'
                          : 'border-white/20'
                      }`}
                      style={{ background: preset.hex }}
                      title={preset.name}
                    />
                  ))}
                </div>
              </div>
            </div>

          ) : activeTab === 'audio' ? (
            <div className="space-y-5 animate-fade-up">

              {/* Microphone Device Selection */}
              <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
                    <Mic className="h-4 w-4 text-emerald-500" /> MICROPHONE INPUT DEVICE
                  </span>
                  <button
                    type="button"
                    onClick={refreshDevices}
                    className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2 py-1 font-mono text-[9px] text-graphite hover:text-ink"
                    title="Refresh device list"
                  >
                    <RefreshCw className="h-3 w-3" /> REFRESH
                  </button>
                </div>

                <select
                  value={settings.inputDeviceId || 'default'}
                  onChange={(e) => {
                    stopMicLoopback();
                    stopLiveMonitor();
                    onUpdateSettings({ inputDeviceId: e.target.value });
                  }}
                  className="w-full rounded-xl border border-line bg-panel px-3.5 py-2.5 font-sans text-xs font-semibold text-ink outline-none transition focus:border-ink"
                >
                  <option value="default">Default System Microphone</option>
                  {inputDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>

                {/* THE MIC TEST — Discord "Let's Check Mic" flow in ONE
                    button: live meter + 5s recording through your actual
                    noise filters, then automatic playback so you literally
                    HEAR your own voice exactly as SERA hears it. */}
                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={toggleMicLoopback}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-1.5 font-mono text-[10px] font-bold tracking-wider transition ${
                      micTestPhase === 'recording'
                        ? 'border-red-500 bg-red-500/10 text-red-400 animate-pulse'
                        : micTestPhase === 'playing'
                          ? 'border-cyan-500 bg-cyan-500/10 text-cyan-400 animate-pulse'
                          : 'border-line bg-panel text-graphite hover:text-ink'
                    }`}
                  >
                    {micTestPhase === 'recording' ? <Activity className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {micTestPhase === 'recording'
                      ? `RECORDING… ${micTestCountdown}s — CLICK TO SKIP`
                      : micTestPhase === 'playing'
                        ? 'PLAYING YOUR VOICE — CLICK TO STOP'
                        : 'TEST MIC & HEAR MYSELF'}
                  </button>

                  {/* Discord-style segmented live meter — lights up as you speak */}
                  <div className="flex flex-1 items-center gap-2">
                    <div className="flex h-3 flex-1 items-center justify-between gap-[2px]">
                      {Array.from({ length: 26 }).map((_, i) => {
                        const lit = i < Math.round((micTestLevel / 100) * 26);
                        return (
                          <div
                            key={i}
                            className="h-2.5 w-[3px] rounded-sm transition-colors duration-75"
                            style={{
                              background: lit
                                ? i > 20
                                  ? '#ff3b5c'
                                  : i > 16
                                    ? '#facc15'
                                    : '#10b981'
                                : 'rgba(255,255,255,0.08)',
                            }}
                          />
                        );
                      })}
                    </div>
                    <span className="w-8 text-right font-mono text-[10px] text-graphite font-bold">
                      {micTestLevel}%
                    </span>
                  </div>
                </div>
                <p className="font-mono text-[9px] leading-relaxed text-graphite/70">
                  Speak for 5 seconds — SERA records it through your noise
                  filters, then plays your own voice back through your chosen
                  speaker. Click again to skip or stop.
                </p>

                {/* Discord "Let Me Hear" — LIVE continuous self-monitor */}
                <div className="space-y-1.5 pt-3">
                  <button
                    type="button"
                    onClick={() => void (liveMonitorOn ? stopLiveMonitor() : startLiveMonitor())}
                    className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition ${
                      liveMonitorOn
                        ? 'border-red-500/70 bg-red-500/10 ring-1 ring-red-500/40'
                        : 'border-line bg-panel hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Headphones className={`h-4 w-4 ${liveMonitorOn ? 'text-red-400' : 'text-cyan-500'}`} />
                      <div>
                        <span className="block font-sans text-xs font-bold text-ink">
                          LET ME HEAR (LIVE)
                        </span>
                        <span className="block font-mono text-[9px] leading-relaxed text-graphite">
                          {liveMonitorOn
                            ? 'LIVE — speak, you hear yourself instantly through your chosen speaker'
                            : 'Real-time mic monitoring, exactly like Discord. No recording — your voice reaches your ears instantly.'}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`ml-3 shrink-0 rounded-full px-2.5 py-1 font-mono text-[9px] font-bold tracking-wider ${
                        liveMonitorOn ? 'bg-red-500/20 text-red-300' : 'bg-white/5 text-graphite'
                      } ${liveMonitorOn ? 'animate-pulse' : ''}`}
                    >
                      {liveMonitorOn ? '● ON — CLICK TO STOP' : 'OFF — CLICK TO START'}
                    </span>
                  </button>
                  <p className="font-mono text-[9px] leading-relaxed text-amber-500/80">
                    ⚠ Use HEADPHONES with this — on open speakers your mic will
                    hear itself and echo (same as Discord). The INPUT GAIN slider
                    below tunes how loud you hear yourself, live.
                  </p>
                </div>

                {/* Input Gain Slider */}
                <div className="space-y-1.5 pt-2 border-t border-line/40">
                  <div className="flex items-center justify-between font-mono text-[10px]">
                    <span className="text-graphite font-medium">INPUT GAIN AMPLIFICATION</span>
                    <span className="font-bold text-ink">{Math.round(settings.inputGain * 100)}%</span>
                  </div>
                  <input
                    type="range" min="0.2" max="2.0" step="0.05"
                    value={settings.inputGain}
                    onChange={(e) => onUpdateSettings({ inputGain: parseFloat(e.target.value) })}
                    className="sera-range"
                    aria-label="Microphone input gain"
                  />
                </div>
              </div>

              {/* Speaker Output Device Selection */}
              <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
                    <Headphones className="h-4 w-4 text-cyan-500" /> SPEAKER / HEADPHONE OUTPUT
                  </span>
                  <button
                    type="button"
                    onClick={playTestSpeakerSound}
                    disabled={isPlayingTestChime}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-panel px-3 py-1 font-mono text-[10px] font-bold text-graphite hover:text-ink active:scale-95 disabled:opacity-50"
                  >
                    <Play className="h-3 w-3 text-cyan-500" />
                    {isPlayingTestChime ? 'PLAYING...' : 'TEST SPEAKER'}
                  </button>
                </div>

                <select
                  value={settings.outputDeviceId || 'default'}
                  onChange={(e) => {
                    stopLiveMonitor();
                    onUpdateSettings({ outputDeviceId: e.target.value });
                  }}
                  className="w-full rounded-xl border border-line bg-panel px-3.5 py-2.5 font-sans text-xs font-semibold text-ink outline-none transition focus:border-ink"
                >
                  <option value="default">Default System Audio Output</option>
                  {outputDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>

                {/* Output Volume Slider */}
                <div className="space-y-1.5 pt-2 border-t border-line/40">
                  <div className="flex items-center justify-between font-mono text-[10px]">
                    <span className="text-graphite font-medium">MASTER PLAYBACK VOLUME</span>
                    <span className="font-bold text-ink">{Math.round(settings.outputVolume * 100)}%</span>
                  </div>
                  <input
                    type="range" min="0.0" max="1.0" step="0.05"
                    value={settings.outputVolume}
                    onChange={(e) => onUpdateSettings({ outputVolume: parseFloat(e.target.value) })}
                    className="sera-range"
                    aria-label="Speaker output volume"
                  />
                </div>
              </div>

              {/* Voice cleanup — the Discord voice suite */}
              <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
                <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
                  <ShieldCheck className="h-4 w-4 text-violet-500" /> VOICE CLEANUP (DISCORD-STYLE)
                </span>
                <p className="font-mono text-[9px] leading-relaxed text-graphite/70">
                  Applied live to your mic in every session AND in the mic
                  test above — same pipeline Discord uses.
                </p>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ noiseSuppression: !(settings.noiseSuppression ?? true) })}
                    className={`flex items-center justify-between rounded-xl border p-3 text-left transition ${
                      settings.noiseSuppression !== false
                        ? 'border-line-strong bg-panel ring-1 ring-ink'
                        : 'border-line bg-paper/60 opacity-60'
                    }`}
                  >
                    <div>
                      <span className="block font-sans text-xs font-bold text-ink">Noise Suppression</span>
                      <span className="block font-mono text-[9px] text-graphite">Removes fan, hum &amp; keyboard noise</span>
                    </div>
                    {settings.noiseSuppression !== false && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ echoCancellation: !(settings.echoCancellation ?? true) })}
                    className={`flex items-center justify-between rounded-xl border p-3 text-left transition ${
                      settings.echoCancellation !== false
                        ? 'border-line-strong bg-panel ring-1 ring-ink'
                        : 'border-line bg-paper/60 opacity-60'
                    }`}
                  >
                    <div>
                      <span className="block font-sans text-xs font-bold text-ink">Echo Cancellation</span>
                      <span className="block font-mono text-[9px] text-graphite">Sera never hears her own voice</span>
                    </div>
                    {settings.echoCancellation !== false && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ autoGainControl: !(settings.autoGainControl ?? true) })}
                    className={`flex items-center justify-between rounded-xl border p-3 text-left transition ${
                      settings.autoGainControl !== false
                        ? 'border-line-strong bg-panel ring-1 ring-ink'
                        : 'border-line bg-paper/60 opacity-60'
                    }`}
                  >
                    <div>
                      <span className="block font-sans text-xs font-bold text-ink">Auto Mic Volume</span>
                      <span className="block font-mono text-[9px] text-graphite">Auto gain — steady level, always</span>
                    </div>
                    {settings.autoGainControl !== false && <Check className="h-3.5 w-3.5 text-emerald-500" />}
                  </button>
                </div>

                {/* Wake-word switch — hands-free "Hey Sera" listener */}
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ wakeWordEnabled: settings.wakeWordEnabled === false })}
                  className={`mt-3 flex w-full items-center justify-between rounded-xl border p-3 text-left transition ${
                    settings.wakeWordEnabled !== false
                      ? 'border-line-strong bg-panel ring-1 ring-ink'
                      : 'border-line bg-paper/60 opacity-60'
                  }`}
                >
                  <div>
                    <span className="block font-sans text-xs font-bold text-ink">Wake Word — "Hey Sera"</span>
                    <span className="block font-mono text-[9px] leading-relaxed text-graphite">
                      ON (default): Sera hears her name whenever the app is idle, even with her window minimized.
                      OFF: she only listens when you click her mic button or type.
                    </span>
                  </div>
                  {settings.wakeWordEnabled !== false ? (
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <span className="shrink-0 font-mono text-[9px] font-bold tracking-widest text-graphite">MANUAL</span>
                  )}
                </button>
              </div>
            </div>

          ) : activeTab === 'voice' ? (
            <div className="space-y-4">
              {/* Unprompted speech control — "she kept interrupting me" fix */}
              <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
                <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
                  <Sparkles className="h-4 w-4 text-amber-500" /> UNPROMPTED SPEECH
                </span>
                <button
                  type="button"
                  onClick={() => onUpdateSettings({ voiceGreetings: !(settings.voiceGreetings ?? false) })}
                  className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition ${
                    settings.voiceGreetings === true
                      ? 'border-line-strong bg-panel ring-1 ring-ink'
                      : 'border-line bg-paper/60'
                  }`}
                >
                  <div>
                    <span className="block font-sans text-xs font-bold text-ink">Voice Greetings</span>
                    <span className="block font-mono text-[9px] leading-relaxed text-graphite">
                      OFF (default): Sera never speaks first — she only answers when you say something.
                      ON: she says a short hello when woken by voice.
                    </span>
                  </div>
                  {settings.voiceGreetings === true ? (
                    <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                  ) : (
                    <span className="shrink-0 font-mono text-[9px] font-bold tracking-widest text-graphite">SILENT</span>
                  )}
                </button>
                <p className="font-mono text-[9px] leading-relaxed text-graphite/70">
                  Say <strong>“full quit”</strong>, <strong>“bye sera”</strong> or{' '}
                  <strong>“stop listening”</strong> anytime and Sera goes fully quiet — no
                  re-greetings, no wake-word, nothing — until you click her or type.
                </p>
              </div>

              <div>
                <span className="block font-mono text-[11px] tracking-[0.16em] text-graphite mb-1">SELECT SYNTHESIS PERSONA</span>
                <p className="font-mono text-[10px] text-graphite/60">Choose the voice character and tonality for Sera.</p>
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {APP_CONFIG.availableVoices.map((voice) => {
                  const isSelected = settings.voice === voice.id;
                  const v = voice as { id: string; label: string; desc?: string; gender: string; emoji?: string };
                  return (
                    <button
                      key={voice.id}
                      type="button"
                      onClick={() => onUpdateSettings({ voice: voice.id as VoiceName })}
                      className={`flex flex-col gap-2 rounded-2xl border p-4 text-left transition-all duration-150 ${
                        isSelected
                          ? 'border-line-strong bg-paper shadow-md ring-1 ring-ink'
                          : 'border-line bg-paper/50 hover:border-line-strong hover:bg-paper'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-lg leading-none">{v.emoji || '🎙️'}</span>
                          <div>
                            <span className="block font-sans text-sm font-bold text-ink">{voice.label}</span>
                            <span className="block font-mono text-[9px] tracking-[0.1em] text-graphite uppercase">{v.gender}</span>
                          </div>
                        </div>
                        {isSelected && (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ink text-paper">
                            <Check className="h-3 w-3" />
                          </span>
                        )}
                      </div>
                      {v.desc && (
                        <p className="font-mono text-[10px] leading-relaxed text-graphite">{v.desc}</p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

          ) : activeTab === 'mypc' ? (
            <MyPcTab settings={settings} onUpdateSettings={onUpdateSettings} onOpenSetupWizard={onOpenSetupWizard} onOpenUninstall={onOpenUninstall} />

          ) : activeTab === 'memory' ? (
            <MemorySettingsTab />

          ) : activeTab === 'keys' ? (
            <ApiKeySettingsTab />

          ) : activeTab === 'models' ? (
            <ModelsProvidersTab />

          ) : (
            <SpeakerRecognitionTab
              enabled={settings.speakerRecognition}
              onEnabledChange={(speakerRecognition) => onUpdateSettings({ speakerRecognition })}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-end border-t border-line bg-paper px-6 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-ink px-6 py-2.5 font-mono text-xs font-bold tracking-[0.16em] text-paper shadow-sm transition hover:opacity-90 active:scale-95"
          >
            APPLY &amp; CLOSE
          </button>
        </div>
      </div>
    </div>
  );
};
