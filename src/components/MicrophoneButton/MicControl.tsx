import React, { useEffect, useState, useMemo } from 'react';
import { Sparkles, Radio, PhoneOff, PhoneCall, Mic, Zap, Volume2, Activity, Moon, Sliders, AlertTriangle } from 'lucide-react';
import { AssistantStateType, AudioVisualizerData, ColorPaletteId } from '../../types';
import { getPaletteConfig } from '../../config/palettes';

interface VoiceDeckProps {
  state: AssistantStateType;
  visualizerData?: AudioVisualizerData;
  errorMessage?: string | null;
  paletteId?: ColorPaletteId;
  customColor?: string;
  permissionGranted?: boolean | null;
  isDesktop: boolean;
  speechStatus?: string;
  speechError?: string | null;
  /** True when SERA is in FULL SLEEP after a "full quit" style command. */
  sleepMode?: boolean;
  onRequestPermission?: () => void;
  onOpenDesktop?: () => void;
  onOpenVoiceSettings?: () => void;
  onInterrupt?: () => void;
  onToggleTalk?: () => void;
}

const POINTS = 64;
const WAVE_WIDTH = 420;
const WAVE_HEIGHT = 38;

export const MicControl: React.FC<VoiceDeckProps> = React.memo(({
  state,
  visualizerData,
  errorMessage,
  paletteId,
  customColor,
  speechStatus,
  sleepMode,
  onInterrupt,
  onOpenVoiceSettings,
  onToggleTalk,
}) => {
  const isConnected = state === 'listening' || state === 'speaking' || state === 'processing';
  const isSpeaking = state === 'speaking';
  const isListening = state === 'listening';
  const isConnecting = state === 'connecting' || state === 'wake_word_detected';
  const isWakeWord = state === 'wake_word_detected';
  const isError = state === 'error';
  const isWakeActive = speechStatus === 'STARTED' || speechStatus === 'READY' || speechStatus === 'IDLE' || speechStatus === 'STARTING';
  const palette = getPaletteConfig(paletteId, customColor);

  // Active session stopwatch
  const [sessionSeconds, setSessionSeconds] = useState(0);

  useEffect(() => {
    if (!isConnected) {
      setSessionSeconds(0);
      return;
    }
    const timer = window.setInterval(() => {
      setSessionSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isConnected]);

  const formatSessionTime = (total: number) => {
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Audio Waveform & Telemetry math for active mode
  const { topPoints, bottomPoints, fillPath, bassAvg, midAvg, highAvg, peakDb } = useMemo(() => {
    const top: [number, number][] = [];
    const bottom: [number, number][] = [];
    const mid = WAVE_HEIGHT / 2;

    if (!visualizerData || !isConnected) {
      return {
        topPoints: `0,${mid} ${WAVE_WIDTH},${mid}`,
        bottomPoints: `0,${mid} ${WAVE_WIDTH},${mid}`,
        fillPath: '',
        bassAvg: 0,
        midAvg: 0,
        highAvg: 0,
        peakDb: -60,
      };
    }

    const bins = visualizerData.frequencies.length || 64;
    let bassSum = 0, midSum = 0, highSum = 0;

    for (let i = 0; i < POINTS; i++) {
      const x = (i / (POINTS - 1)) * WAVE_WIDTH;
      const binIdx = Math.min(bins - 1, Math.floor((i / POINTS) * bins * 0.78));
      const raw = (visualizerData.frequencies[binIdx] || 0) / 255;

      if (i < POINTS * 0.28) bassSum += raw;
      else if (i < POINTS * 0.68) midSum += raw;
      else highSum += raw;

      const level = isSpeaking
        ? Math.max(0.25, visualizerData.speakerLevel)
        : Math.max(0.20, visualizerData.micLevel);
      const amp = raw * (WAVE_HEIGHT / 2 - 3) * Math.min(1.4, level * 2.4);

      top.push([x, mid - amp]);
      bottom.push([x, mid + amp * 0.85]);
    }

    const buildPath = (pts: [number, number][], reverse = false) => {
      const p = reverse ? [...pts].reverse() : pts;
      if (p.length === 0) return '';
      let d = `M ${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
      for (let i = 1; i < p.length; i++) {
        d += ` L ${p[i][0].toFixed(1)} ${p[i][1].toFixed(1)}`;
      }
      return d;
    };

    const topPathStr = buildPath(top);
    const bottomPathRevStr = buildPath(bottom, true);
    const fill = `${topPathStr} ${bottomPathRevStr.replace('M', 'L')} Z`;

    const b = Math.min(100, Math.round((bassSum / (POINTS * 0.28)) * 100));
    const m = Math.min(100, Math.round((midSum / (POINTS * 0.40)) * 100));
    const h = Math.min(100, Math.round((highSum / (POINTS * 0.32)) * 100));
    const db = Math.round(20 * Math.log10(Math.max(0.001, isSpeaking ? visualizerData.speakerLevel : visualizerData.micLevel)));

    return {
      topPoints: top.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      bottomPoints: bottom.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
      fillPath: fill,
      bassAvg: b,
      midAvg: m,
      highAvg: h,
      peakDb: Math.max(-60, Math.min(0, db)),
    };
  }, [visualizerData, isConnected, isSpeaking]);

  const renderLedBars = (pct: number) => {
    const totalBars = 4;
    const litBars = Math.ceil((pct / 100) * totalBars);
    return (
      <span className="inline-flex items-center gap-[2px]">
        {Array.from({ length: totalBars }).map((_, i) => (
          <span
            key={i}
            className="h-2 w-[2.5px] rounded-[1px] transition-colors duration-150"
            style={{
              background:
                i < litBars
                  ? palette.lamp
                  : 'rgba(255, 255, 255, 0.12)',
              boxShadow: i < litBars ? `0 0 4px ${palette.lamp}` : 'none',
            }}
          />
        ))}
      </span>
    );
  };

  return (
    <div className="flex w-full max-w-lg flex-col items-center justify-center select-none z-30">
      {!isConnected ? (
        /* ── 1. STANDBY PILL DOCK ──
            In FULL SLEEP the dock shows the moon state: the wake-word
            listener is OFF, nothing can interrupt. Clicking = explicit
            wake ("when I need you I will ask"). */
        <div
          key="standby-dock"
          className="relative flex w-full items-center justify-between overflow-hidden rounded-full border p-2 pl-5 pr-2.5 bg-white/[0.03] backdrop-blur-3xl shadow-[0_12px_40px_rgba(0,0,0,0.5)] animate-deck-popup"
          style={{
            borderColor: isWakeWord
              ? '#ffd16699'
              : isError || sleepMode
              ? 'rgba(255, 59, 92, 0.5)'
              : 'rgba(255, 255, 255, 0.15)',
            boxShadow: isWakeWord
              ? '0 16px 48px rgba(0, 0, 0, 0.6), 0 0 35px rgba(255, 209, 102, 0.3), inset 0 1px 0 rgba(255,255,255,0.12)'
              : '0 12px 40px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
        >
          {/* Status Indicator & Prompt Tip */}
          <div className="flex items-center gap-2.5">
            {sleepMode ? (
              <Moon className="h-3.5 w-3.5 text-indigo-300" />
            ) : (
              <span className="relative flex h-2.5 w-2.5">
                {(isWakeWord || isConnecting) && (
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                    style={{ background: isWakeWord ? '#ffd166' : '#38bdf8' }}
                  />
                )}
                <span
                  className="relative inline-flex h-2.5 w-2.5 rounded-full shadow-[0_0_10px] transition-all duration-300"
                  style={{
                    background: isError ? '#ff3b5c' : isWakeWord ? '#ffd166' : '#10b981',
                    boxShadow: isError
                      ? '0 0 10px #ff3b5c'
                      : isWakeWord
                      ? '0 0 10px #ffd166'
                      : '0 0 8px #10b981',
                  }}
                />
              </span>
            )}

            <span className="font-mono text-[10px] font-black tracking-[0.18em] text-white/90 uppercase">
              {sleepMode
                ? 'SLEEPING'
                : isError
                ? 'OFFLINE'
                : isWakeWord
                ? 'WAKING UP...'
                : isWakeActive
                ? 'ALWAYS READY'
                : 'READY'}
            </span>

            <span className="rounded-md border border-white/10 bg-white/[0.05] px-2 py-0.5 font-mono text-[9px] font-bold text-white/60 tracking-wider">
              {sleepMode ? (
                <>FULLY QUIET — NO INTERRUPTIONS</>
              ) : (
                <>SAY <strong className="text-white font-extrabold">"HEY SERA"</strong></>
              )}
            </span>
          </div>

          {/* Talk / Wake Button */}
          <button
            type="button"
            onClick={onToggleTalk}
            disabled={isConnecting}
            aria-label={sleepMode ? 'Wake Sera up' : 'Start talking to Sera'}
            className="group relative flex items-center gap-2 rounded-full border px-5 py-2 font-mono text-xs font-black tracking-[0.14em] transition-all duration-300 hover:scale-105 active:scale-95 disabled:opacity-50 shadow-lg"
            style={{
              borderColor: sleepMode ? 'rgba(129, 140, 248, 0.7)' : `${palette.lamp}88`,
              background: sleepMode
                ? 'linear-gradient(135deg, rgba(129, 140, 248, 0.30) 0%, rgba(10, 12, 18, 0.95) 100%)'
                : `linear-gradient(135deg, ${palette.lamp}35 0%, rgba(10, 12, 18, 0.95) 100%)`,
              boxShadow: sleepMode
                ? '0 0 20px rgba(129, 140, 248, 0.45)'
                : `0 0 20px ${palette.lampGlow || 'rgba(0, 229, 255, 0.3)'}`,
            }}
          >
            {isConnecting ? (
              <>
                <Radio className="h-3.5 w-3.5 animate-spin" style={{ color: palette.lamp }} />
                <span className="text-white/80">CONNECTING</span>
              </>
            ) : sleepMode ? (
              <>
                <Moon className="h-3.5 w-3.5 text-indigo-200 transition-transform group-hover:scale-110" />
                <span className="text-white font-extrabold">WAKE UP</span>
              </>
            ) : (
              <>
                <PhoneCall className="h-3.5 w-3.5 transition-transform group-hover:scale-110" style={{ color: palette.lamp }} />
                <span className="text-white font-extrabold">TALK TO SERA</span>
              </>
            )}
          </button>
        </div>
      ) : (
        /* ── 2. ACTIVE CYBER-VOICE COCKPIT (Image 3) ── */
        <div
          key="active-deck"
          className="relative flex w-full flex-col overflow-hidden rounded-3xl border p-4 gap-3 bg-white/[0.04] backdrop-blur-3xl shadow-[0_16px_48px_rgba(0,0,0,0.6)] animate-deck-popup"
          style={{
            borderColor: `${palette.lamp}55`,
            boxShadow: `0 16px 48px rgba(0, 0, 0, 0.6), 0 0 35px ${palette.lampGlow || 'rgba(0, 229, 255, 0.25)'}, inset 0 1px 0 rgba(255,255,255,0.12)`,
          }}
        >
          {/* Top Status Header */}
          <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                  style={{ background: isSpeaking ? palette.lamp : '#10b981' }}
                />
                <span
                  className="relative inline-flex h-2 w-2 rounded-full shadow-[0_0_8px]"
                  style={{
                    background: isSpeaking ? palette.lamp : '#10b981',
                    boxShadow: `0 0 8px ${isSpeaking ? palette.lamp : '#10b981'}`,
                  }}
                />
              </span>
              <span
                className="font-mono text-[10px] font-black tracking-[0.16em] uppercase"
                style={{ color: isSpeaking ? palette.lamp : '#ffffff' }}
              >
                {isSpeaking ? 'SERA TRANSMITTING' : 'LISTENING TO YOU'}
              </span>
            </div>

            {/* Session Stopwatch + Voice Settings shortcut */}
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 font-mono text-[10px] font-extrabold tracking-widest text-white/60">
                <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
                <span>{formatSessionTime(sessionSeconds)}</span>
              </div>

              {onOpenVoiceSettings && (
                <button
                  type="button"
                  onClick={onOpenVoiceSettings}
                  aria-label="Open mic & speaker settings"
                  title="Mic test, noise suppression, echo cancellation, devices"
                  className="flex h-6 w-6 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/50 transition hover:border-white/25 hover:bg-white/[0.12] hover:text-white active:scale-90"
                >
                  <Sliders className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* Live Audio Oscilloscope SVG Waveform */}
          <div className="relative flex h-9 w-full items-center justify-center overflow-hidden rounded-xl bg-black/40 border border-white/[0.06] px-2">
            <svg
              viewBox={`0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}`}
              className="h-full w-full overflow-visible"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="cyberWaveGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stopColor={palette.lamp} stopOpacity="0.2" />
                  <stop offset="50%" stopColor={palette.lamp} stopOpacity="1.0" />
                  <stop offset="100%" stopColor={palette.lamp} stopOpacity="0.2" />
                </linearGradient>
                <linearGradient id="cyberWaveFill" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor={palette.lamp} stopOpacity="0.25" />
                  <stop offset="100%" stopColor={palette.lamp} stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {fillPath && <path d={fillPath} fill="url(#cyberWaveFill)" />}
              <line
                x1={0}
                y1={WAVE_HEIGHT / 2}
                x2={WAVE_WIDTH}
                y2={WAVE_HEIGHT / 2}
                stroke="rgba(255,255,255,0.08)"
                strokeWidth={1}
              />
              <polyline
                points={topPoints}
                fill="none"
                stroke="url(#cyberWaveGrad)"
                strokeWidth={2}
                strokeLinecap="round"
              />
            </svg>
          </div>

          {/* Micro Telemetry Frequency Readouts */}
          <div className="flex items-center justify-between font-mono text-[9px] text-white/50 px-1">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <span>BASS</span>
                {renderLedBars(bassAvg)}
                <span className="font-bold text-white/80">{bassAvg}%</span>
              </div>
              <div className="flex items-center gap-1">
                <span>MID</span>
                {renderLedBars(midAvg)}
                <span className="font-bold text-white/80">{midAvg}%</span>
              </div>
              <div className="flex items-center gap-1">
                <span>HIGH</span>
                {renderLedBars(highAvg)}
                <span className="font-bold text-white/80">{highAvg}%</span>
              </div>
            </div>

            <span className="font-extrabold text-white/70">{peakDb} dB</span>
          </div>

          {/* Lower Action Row */}
          <div className="flex w-full items-center justify-between gap-3 pt-1">
            <span className="font-sans text-xs text-white/60 truncate max-w-[200px]">
              {isSpeaking ? 'Sera is speaking...' : 'Go ahead, I’m listening...'}
            </span>

            <div className="flex items-center gap-2">
              {/* Cut-In Button (When Sera is speaking) */}
              {isSpeaking && onInterrupt && (
                <button
                  type="button"
                  onClick={onInterrupt}
                  className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.08] px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-white/90 backdrop-blur-md transition hover:bg-white/[0.16] hover:border-white/30 active:scale-95 shadow-sm"
                  title="Interrupt and speak now"
                >
                  <Zap className="h-3.5 w-3.5 text-yellow-400" />
                  CUT IN
                </button>
              )}

              {/* Disconnect Button */}
              <button
                type="button"
                onClick={onToggleTalk}
                aria-label="End conversation"
                className="group relative flex items-center gap-2 rounded-full border px-5 py-2 font-mono text-xs font-black tracking-[0.14em] transition-all duration-300 hover:scale-105 active:scale-95 shadow-lg"
                style={{
                  borderColor: 'rgba(255, 59, 92, 0.7)',
                  background: 'linear-gradient(135deg, rgba(255, 59, 92, 0.25) 0%, rgba(20, 10, 15, 0.95) 100%)',
                  boxShadow: '0 0 20px rgba(255, 59, 92, 0.4)',
                }}
              >
                <PhoneOff className="h-3.5 w-3.5 text-red-400 group-hover:animate-pulse" />
                <span className="text-red-300 group-hover:text-white">DISCONNECT</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* v1.8.4 — WHY is she offline? The hook has produced errorMessage
          since v1.6, but MicControl accepted it as a prop and NEVER rendered
          it. Local-mode failures (Ollama not installed / not running) were
          completely invisible: the user typed, nothing answered, no error
          anywhere. This strip says exactly what broke and how to fix it. */}
      {errorMessage && (
        <div
          role="alert"
          className="animate-fade-up mt-2.5 flex w-full items-start gap-2.5 rounded-2xl border border-red-500/30 bg-red-950/40 px-3.5 py-2.5 shadow-[0_8px_28px_rgba(0,0,0,0.45)] backdrop-blur-3xl"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-red-400" />
          <p className="text-left font-mono text-[9.5px] leading-relaxed text-red-200/90">{errorMessage}</p>
        </div>
      )}
    </div>
  );
});
