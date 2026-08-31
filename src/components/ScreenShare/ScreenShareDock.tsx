/**
 * v1.7.0 — ScreenShareDock: the floating screen-sharing console.
 *
 * Three honest states, no fake buttons:
 *   IDLE      → the "SHARE SCREEN" glass pill (opens the browser's native
 *               Entire Screen / Application Window / Browser Tab picker).
 *   REQUESTING→ the picker is open; the pill shows a spinner.
 *   SHARING   → the dock: live preview, "SCREEN SHARING ACTIVE" indicator
 *               with a pulsing red dot, and the four controls —
 *               Pause / Resume, Switch source, Screen Vision toggle, Stop.
 *
 * The second status row tells the truth about what SERA can see at any
 * moment (streaming / standby / preview-only / paused / offline-local).
 * Matches the SERA design language: dark glass, backdrop blur, mono
 * micro-labels, palette lamp accents, fade-up animation.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Monitor,
  MonitorUp,
  Pause,
  Play,
  Eye,
  EyeOff,
  X,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Loader2,
  Minus,
  Plus,
  GripHorizontal,
} from 'lucide-react';
import { getPaletteConfig } from '../../config/palettes';
import type { ColorPaletteId } from '../../types';
import type { UseScreenShareResult } from '../../hooks/useScreenShare';

interface ScreenShareDockProps {
  share: UseScreenShareResult;
  paletteId?: ColorPaletteId;
  customColor?: string;
}

/** v1.8.1 — OCR re-scan interval presets (ms), fastest → slowest. */
const OCR_INTERVAL_LADDER = [2_000, 4_000, 8_000, 15_000, 30_000, 60_000] as const;

/**
 * v1.8.4 — dock sizing. The dock used to be a fixed 228px wide with a
 * 112px preview — so tiny the shared screen was unreadable. It is now
 * 340px by default and the user can drag the bottom grip to widen it
 * (260–640px); the choice persists across restarts.
 */
const DOCK_WIDTH_STORAGE_KEY = 'sera_screenshare_dock_width_v1';
const DOCK_DEFAULT_WIDTH = 340;
const DOCK_MIN_WIDTH = 260;
const DOCK_MAX_WIDTH = 640;

function readPersistedDockWidth(): number {
  try {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= DOCK_MIN_WIDTH && saved <= DOCK_MAX_WIDTH) {
      return Math.round(saved);
    }
  } catch { /* storage unavailable — default */ }
  return DOCK_DEFAULT_WIDTH;
}

function formatOcrInterval(ms: number): string {
  return ms >= 1_000 ? `${Math.round(ms / 1_000)}s` : `${ms}ms`;
}

/** Nearest ladder index for the current interval (persisted values may be off-ladder). */
function nearestLadderIndex(ms: number): number {
  let best = 0;
  let bestDistance = Infinity;
  OCR_INTERVAL_LADDER.forEach((preset, index) => {
    const distance = Math.abs(preset - ms);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

export const ScreenShareDock: React.FC<ScreenShareDockProps> = React.memo(({ share, paletteId, customColor }) => {
  const palette = getPaletteConfig(paletteId, customColor);
  const [collapsed, setCollapsed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // v1.8.4 — user-resizable dock width, persisted.
  const [dockWidth, setDockWidth] = useState<number>(() => readPersistedDockWidth());
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  const persistDockWidth = (width: number) => {
    try {
      localStorage.setItem(DOCK_WIDTH_STORAGE_KEY, String(Math.round(width)));
    } catch { /* storage unavailable — keep in-memory width */ }
  };

  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = { x: event.clientX, width: dockWidth };
    setResizing(true);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const next = Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, start.width + (event.clientX - start.x)));
    setDockWidth(next);
  };
  const onResizeEnd = () => {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setResizing(false);
    persistDockWidth(dockWidth);
  };

  // Attach the captured MediaStream to the preview <video>.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== share.stream) {
      video.srcObject = share.stream;
      if (share.stream) void video.play().catch(() => undefined);
    }
  }, [share.stream, collapsed]);

  // Errors self-dismiss — they are notices, not blockers. (Deps are the
  // actual changing values; the share object identity is stable between
  // real state changes, so this timer is NOT restarted by visualizer churn.)
  const dismissError = share.dismissError;
  useEffect(() => {
    if (!share.error) return;
    const timer = setTimeout(() => dismissError(), 9000);
    return () => clearTimeout(timer);
  }, [share.error, dismissError]);

  // ── IDLE / REQUESTING: the Share Screen pill ─────────────────────
  if (share.phase === 'idle' || share.phase === 'requesting') {
    const requesting = share.phase === 'requesting';
    return (
      <div className="flex flex-col items-start gap-1.5">
        <button
          type="button"
          onClick={() => void share.start()}
          disabled={requesting}
          className={`group flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[8px] font-bold tracking-wider backdrop-blur-sm transition-all duration-200 hover:scale-[1.03] active:scale-95 ${
            requesting
              ? 'border-white/20 bg-black/50 text-white/60'
              : 'border-white/15 bg-black/40 text-white/80 hover:border-white/35 hover:bg-black/60 hover:text-white'
          }`}
          title="Share your entire screen, an application window, or a browser tab with SERA — she will be able to see and talk about whatever is on it."
          aria-label="Share your screen with SERA"
        >
          {requesting ? (
            <Loader2 className="h-3 w-3 animate-spin" style={{ color: palette.lamp }} />
          ) : (
            <Monitor className="h-3 w-3 transition-transform duration-200 group-hover:scale-110" style={{ color: palette.lamp }} />
          )}
          <span>{requesting ? 'PICK A SCREEN…' : 'SHARE SCREEN'}</span>
        </button>
        {share.error && <ErrorStrip error={share.error.message} lamp={palette.lamp} />}
      </div>
    );
  }

  // ── ACTIVE / PAUSED: the floating dock ────────────────────────────
  const isPaused = share.phase === 'paused';
  const status = sharingStatus(share);

  return (
    <div
      className={`animate-fade-up overflow-hidden rounded-2xl border border-white/10 bg-black/55 shadow-[0_8px_32px_rgba(0,0,0,0.55)] backdrop-blur-2xl ${resizing ? 'select-none' : ''}`}
      style={{ width: dockWidth }}
      role="region"
      aria-label="Screen sharing controls"
    >
      {/* Header: pulsing LIVE indicator + collapse toggle */}
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1.5">
        <div className="flex items-center gap-1.5 font-mono text-[9px] font-bold tracking-wider">
          <span className="relative flex h-2 w-2">
            {!isPaused && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${isPaused ? 'bg-amber-500' : 'bg-red-500'}`} />
          </span>
          <span className={isPaused ? 'text-amber-300' : 'text-red-300'}>
            {isPaused ? 'SHARING PAUSED' : 'SCREEN SHARING ACTIVE'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          className="rounded-md p-0.5 text-white/40 transition hover:bg-white/10 hover:text-white"
          title={collapsed ? 'Expand screen share dock' : 'Collapse screen share dock'}
          aria-label={collapsed ? 'Expand screen share dock' : 'Collapse screen share dock'}
        >
          {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Live preview */}
          <div className="relative mx-2.5 overflow-hidden rounded-xl border border-white/10 bg-black">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="block aspect-video w-full object-contain"
              aria-label="Screen sharing preview"
            />
            {isPaused && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 font-mono text-[10px] font-bold tracking-widest text-amber-300 backdrop-blur-[2px]">
                FEED PAUSED
              </div>
            )}
            <div className="pointer-events-none absolute bottom-1 left-1.5 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-white/70 backdrop-blur-sm">
              {sourceLabel(share.source)}
            </div>
          </div>

          {/* Honest vision status */}
          <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 font-mono text-[9px] font-bold tracking-wider">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: status.color, boxShadow: `0 0 6px ${status.color}` }}
            />
            <span className="truncate" style={{ color: status.color }} title={status.hint}>
              {status.label}
            </span>
          </div>

          {/* Telemetry line */}
          <div className="px-2.5 pb-1.5 font-mono text-[8px] tracking-wider text-white/35">
            {share.stats.framesSent} SENT · {share.stats.framesSkipped} SKIPPED
            {share.stats.lastFrameBytes > 0 ? ` · ${Math.round(share.stats.lastFrameBytes / 1024)}KB` : ''}
            {share.channelState && share.channelState.ocrChars > 0
              ? ` · OCR ${share.channelState.ocrChars}c`
              : ''}
          </div>

          {/* v1.8.1 — OCR re-scan interval stepper (live, persisted) */}
          <OcrIntervalRow share={share} />

          {share.error && (
            <div className="px-2.5 pb-1.5">
              <ErrorStrip error={share.error.message} lamp={palette.lamp} />
            </div>
          )}
        </>
      )}

      {/* Controls */}
      <div className="flex items-center gap-1 border-t border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5">
        <ControlButton
          onClick={isPaused ? share.resume : share.pause}
          title={isPaused ? 'Resume sharing frames with SERA' : 'Pause sharing frames (preview keeps running)'}
          label={isPaused ? 'Resume' : 'Pause'}
          active={isPaused}
        >
          {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </ControlButton>

        <ControlButton
          onClick={() => void share.switchSource()}
          title="Switch to a different screen, window, or browser tab"
          label="Switch"
        >
          <MonitorUp className="h-3.5 w-3.5" />
        </ControlButton>

        <ControlButton
          onClick={() => share.setVisionMode(!share.visionMode)}
          title={
            share.visionMode
              ? 'Screen Vision is ON — SERA continuously sees your screen while you share. Click to turn off (frames stay on your device).'
              : 'Screen Vision is OFF — SERA only looks when you ask about the screen. Click to enable continuous vision.'
          }
          label="Vision"
          active={share.visionMode}
          accent={palette.lamp}
        >
          {share.visionMode ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </ControlButton>

        <button
          type="button"
          onClick={share.stop}
          className="ml-auto flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-950/40 px-2 py-1 font-mono text-[9px] font-bold tracking-wider text-red-300 transition hover:border-red-500/70 hover:bg-red-900/50 hover:text-red-200 active:scale-95"
          title="Stop sharing your screen"
          aria-label="Stop screen sharing"
        >
          <X className="h-3 w-3" />
          STOP
        </button>
      </div>

      {/* v1.8.4 — resize grip: drag horizontally to widen / narrow the
          dock. The width persists, so the screen share preview stays at
          the size YOU choose for every future share. */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize screen share dock"
          title={`Drag left or right to resize the dock (${dockWidth}px)`}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          className={`flex h-4 w-full cursor-ew-resize touch-none items-center justify-center border-t border-white/[0.06] transition-colors ${
            resizing ? 'bg-white/[0.10] text-white/80' : 'text-white/25 hover:bg-white/[0.05] hover:text-white/60'
          }`}
        >
          <GripHorizontal className="h-2.5 w-2.5" />
        </div>
      )}
    </div>
  );
});

ScreenShareDock.displayName = 'ScreenShareDock';

// ── pieces ──────────────────────────────────────────────────────────

/** v1.8.1 — compact stepper for the OCR re-scan interval. */
const OcrIntervalRow: React.FC<{ share: UseScreenShareResult }> = ({ share }) => {
  const index = nearestLadderIndex(share.ocrIntervalMs);
  const canDecrease = index > 0;
  const canIncrease = index < OCR_INTERVAL_LADDER.length - 1;
  const step = (direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= OCR_INTERVAL_LADDER.length) return;
    share.setOcrInterval(OCR_INTERVAL_LADDER[next]);
  };
  return (
    <div
      className="flex items-center justify-between border-t border-white/[0.06] px-2.5 py-1"
      title="How often SERA re-reads the visible text on your screen (OCR). Lower = fresher reading and screen memory, higher = less CPU. Applies live and is remembered for next time."
    >
      <span className="font-mono text-[8px] font-bold tracking-wider text-white/35">OCR EVERY</span>
      <div className="flex items-center gap-1">
        <StepButton onClick={() => step(-1)} disabled={!canDecrease} label="Scan less often" aria-label="Decrease OCR interval">
          <Minus className="h-2.5 w-2.5" />
        </StepButton>
        <span className="w-7 text-center font-mono text-[9px] font-bold tabular-nums text-white/75">
          {formatOcrInterval(share.ocrIntervalMs)}
        </span>
        <StepButton onClick={() => step(1)} disabled={!canIncrease} label="Scan more often" aria-label="Increase OCR interval">
          <Plus className="h-2.5 w-2.5" />
        </StepButton>
      </div>
    </div>
  );
};

const StepButton: React.FC<{
  onClick: () => void;
  disabled: boolean;
  label: string;
  'aria-label': string;
  children: React.ReactNode;
}> = ({ onClick, disabled, label, 'aria-label': ariaLabel, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={ariaLabel}
    className="flex h-4 w-4 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/60 transition hover:border-white/25 hover:bg-white/[0.10] hover:text-white active:scale-90 disabled:cursor-not-allowed disabled:opacity-25 disabled:hover:border-white/10 disabled:hover:bg-white/[0.04]"
  >
    {children}
  </button>
);

const ControlButton: React.FC<{
  onClick: () => void;
  title: string;
  label: string;
  active?: boolean;
  accent?: string;
  children: React.ReactNode;
}> = ({ onClick, title, label, active, accent, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-pressed={active}
    className={`flex items-center gap-1 rounded-lg border px-1.5 py-1 font-mono text-[9px] font-bold tracking-wider transition active:scale-95 ${
      active
        ? 'border-white/25 bg-white/[0.12] text-white'
        : 'border-white/10 bg-white/[0.04] text-white/60 hover:border-white/25 hover:bg-white/[0.10] hover:text-white'
    }`}
    style={active && accent ? { borderColor: `${accent}80`, color: accent, background: `${accent}1a` } : undefined}
  >
    {children}
    <span className="hidden sm:inline">{label}</span>
  </button>
);

const ErrorStrip: React.FC<{ error: string; lamp: string }> = ({ error, lamp }) => (
  <div
    className="animate-fade-up flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-950/40 px-2 py-1.5 font-mono text-[7.5px] leading-relaxed tracking-wide text-amber-200/90 backdrop-blur-sm"
    role="alert"
  >
    <AlertTriangle className="mt-px h-3 w-3 shrink-0" style={{ color: lamp }} />
    <span>{error}</span>
  </div>
);

function sourceLabel(source: string): string {
  switch (source) {
    case 'monitor':
      return 'ENTIRE SCREEN';
    case 'window':
      return 'APP WINDOW';
    case 'browser':
      return 'BROWSER TAB';
    default:
      return 'SCREEN';
  }
}

function sharingStatus(share: UseScreenShareResult): { label: string; color: string; hint: string } {
  if (!share.visionAvailable) {
    const ocrChars = share.channelState?.ocrChars ?? 0;
    if (ocrChars > 0) {
      return {
        label: `VISION: LOCAL · OCR (${ocrChars} chars)`,
        color: '#38bdf8',
        hint: 'Local-first vision is active. SERA extracts visible screen text locally via OCR and executes computer control offline.',
      };
    }
    return {
      label: 'VISION: LOCAL · SCREEN ACTIVE',
      color: '#38bdf8',
      hint: 'Local-first screen capture active. Local models process OCR and safe system control locally.',
    };
  }
  if (!share.visionMode) {
    return {
      label: 'VISION: LOCAL-FIRST · ON-DEMAND',
      color: '#94a3b8',
      hint: 'Frames stay on your device. SERA analyzes visual context only when you ask a screen question.',
    };
  }
  if (share.phase === 'paused') {
    return {
      label: 'SCREEN SHARING: PAUSED',
      color: '#fbbf24',
      hint: 'Frame feed is paused — click Resume to restore active visual analysis.',
    };
  }
  if (share.streaming) {
    return {
      label: 'VISION: LOCAL-FIRST · ONLINE REASONING AVAILABLE',
      color: '#34d399',
      hint: 'Local capture is active with change detection. Useful visual context is streamed to online reasoning when needed.',
    };
  }
  return {
    label: 'VISION: LOCAL-FIRST · STANDBY',
    color: '#38bdf8',
    hint: 'Local capture active. Frames buffer locally and stream when a reasoning session connects.',
  };
}
