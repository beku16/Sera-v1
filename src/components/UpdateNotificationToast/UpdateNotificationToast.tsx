import React from 'react';
import { Sparkles, Download, ArrowRight, X, Clock, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { UpdateState, ColorPaletteId } from '../../types';
import { getPaletteConfig } from '../../config/palettes';
import { APP_VERSION } from '../../generated/appVersion';

interface UpdateNotificationToastProps {
  isVisible: boolean;
  updateState: UpdateState;
  paletteId?: ColorPaletteId;
  customColor?: string;
  onUpdateNow: () => void;
  onViewDetails: () => void;
  onLater: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '0.0 MB/s';
  const mb = bytesPerSec / (1024 * 1024);
  return `${mb.toFixed(1)} MB/s`;
}

export const UpdateNotificationToast: React.FC<UpdateNotificationToastProps> = ({
  isVisible,
  updateState,
  paletteId,
  customColor,
  onUpdateNow,
  onViewDetails,
  onLater,
}) => {
  if (!isVisible || !updateState.info.hasUpdate) return null;

  const palette = getPaletteConfig(paletteId, customColor);
  const currentVersion = updateState.info.currentVersion || APP_VERSION;
  const latestVersion = updateState.info.latestVersion || 'new version';
  const isDownloading = updateState.status === 'downloading';
  const isReady = updateState.status === 'ready-to-install';
  const isError = updateState.status === 'error';
  const isInstalling = updateState.status === 'installing';

  const progress = updateState.progress;
  const etaText = progress.etaSeconds !== null ? `~${Math.ceil(progress.etaSeconds)}s remaining` : 'Calculating...';

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex w-full max-w-md flex-col overflow-hidden rounded-3xl border border-cyan-500/40 bg-[#0a0d14]/95 p-5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.9),0_0_30px_rgba(6,182,212,0.2)] backdrop-blur-2xl transition-all duration-300 animate-slide-in-right select-none"
      style={{
        borderColor: isReady ? 'rgba(52, 211, 153, 0.5)' : isError ? 'rgba(244, 63, 94, 0.5)' : `${palette.lamp}66`,
        boxShadow: isReady
          ? '0 20px 60px rgba(0,0,0,0.9), 0 0 35px rgba(52, 211, 153, 0.25)'
          : isError
          ? '0 20px 60px rgba(0,0,0,0.9), 0 0 35px rgba(244, 63, 94, 0.25)'
          : `0 20px 60px rgba(0,0,0,0.9), 0 0 35px ${palette.lampGlow || 'rgba(6,182,212,0.25)'}`,
      }}
      role="dialog"
      aria-live="polite"
      aria-label="SERA Update Notification"
    >
      {/* ─── Header Bar ────────────────────────────────────────── */}
      <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${
                isReady ? 'bg-emerald-400' : isError ? 'bg-rose-400' : 'bg-cyan-400'
              }`}
            />
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                isReady ? 'bg-emerald-400' : isError ? 'bg-rose-400' : 'bg-cyan-400'
              }`}
            />
          </span>
          <span
            className={`font-mono text-[11px] font-black tracking-[0.18em] uppercase ${
              isReady ? 'text-emerald-300' : isError ? 'text-rose-300' : 'text-cyan-300'
            }`}
          >
            {isReady
              ? '✓ UPDATE READY'
              : isDownloading
              ? '✦ DOWNLOADING UPDATE'
              : isInstalling
              ? '🔄 APPLYING UPDATE...'
              : isError
              ? '⚠ UPDATE FAILED'
              : '✦ SERA UPDATE AVAILABLE'}
          </span>
        </div>

        <button
          type="button"
          onClick={onLater}
          className="flex h-7 w-7 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/50 transition hover:bg-white/10 hover:text-white active:scale-95"
          title="Dismiss (Later)"
          aria-label="Dismiss update notification"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* ─── Body Content ──────────────────────────────────────── */}
      <div className="py-4 space-y-3.5">
        {/* STATE 1: DOWNLOADING PROGRESS */}
        {isDownloading ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between font-mono text-xs">
              <span className="font-bold text-white/90">SERA {latestVersion}</span>
              <span className="font-black text-cyan-300 text-sm">{progress.percent}%</span>
            </div>

            {/* Glowing Futuristic Progress Track */}
            <div className="h-2.5 w-full overflow-hidden rounded-full border border-white/10 bg-panel/80 p-0.5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-cyan-500 via-teal-400 to-emerald-400 transition-all duration-300 shadow-[0_0_15px_rgba(6,182,212,0.8)]"
                style={{ width: `${Math.max(4, progress.percent)}%` }}
              />
            </div>

            {/* Metrics: Bytes, Speed & ETA */}
            <div className="flex flex-wrap items-center justify-between font-mono text-[11px] text-graphite gap-1">
              <span>
                {formatBytes(progress.bytesDownloaded)} / {formatBytes(progress.totalBytes)}
              </span>
              <span>
                {formatSpeed(progress.speedBytesPerSec)} · {etaText}
              </span>
            </div>
          </div>
        ) : isReady ? (
          /* STATE 2: UPDATE READY TO APPLY */
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-emerald-500/30 bg-emerald-950/40 shadow-[0_0_20px_rgba(52,211,153,0.3)]">
              <CheckCircle2 className="h-6 w-6 text-emerald-400" />
            </div>
            <div className="space-y-1">
              <h4 className="font-sans text-xs font-bold text-white">SERA {latestVersion} Ready</h4>
              <p className="font-mono text-[11px] leading-relaxed text-emerald-200/90">
                Package downloaded and cryptographically verified. Ready to restart and apply.
              </p>
            </div>
          </div>
        ) : isError ? (
          /* STATE 3: ERROR STATE */
          <div className="flex items-start gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-rose-500/30 bg-rose-950/40 shadow-[0_0_20px_rgba(244,63,94,0.3)]">
              <AlertTriangle className="h-6 w-6 text-rose-400" />
            </div>
            <div className="space-y-1">
              <h4 className="font-sans text-xs font-bold text-white">Download Incomplete</h4>
              <p className="font-mono text-[11px] leading-relaxed text-rose-200/90">
                {updateState.errorMessage || 'Unable to complete update package download.'}
              </p>
            </div>
          </div>
        ) : (
          /* STATE 4: UPDATE AVAILABLE INTRO */
          <div className="space-y-3">
            <p className="font-mono text-xs text-white/80 leading-relaxed">
              A new version of SERA is ready with performance enhancements and updates.
            </p>

            {/* Version Comparison Card */}
            <div className="rounded-2xl border border-white/10 bg-panel/60 p-3 font-mono text-xs space-y-1.5 shadow-inner">
              <div className="flex items-center justify-between">
                <span className="text-graphite">Current version</span>
                <span className="font-semibold text-white/70">{currentVersion}</span>
              </div>
              <div className="flex items-center justify-between border-t border-white/[0.06] pt-1.5">
                <span className="text-cyan-300 font-medium">New version</span>
                <span className="font-bold text-cyan-300 flex items-center gap-1.5">
                  {latestVersion}
                  <span className="rounded-md border border-cyan-500/40 bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-black text-cyan-300">
                    NEW
                  </span>
                </span>
              </div>
            </div>

            {/* Release Description snippet */}
            {updateState.info.releaseName && (
              <div className="flex items-center gap-2 font-mono text-[11px] text-white/60">
                <Sparkles className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                <span className="truncate">{updateState.info.releaseName}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Footer Action Buttons ─────────────────────────────── */}
      <div className="flex items-center justify-between pt-3 border-t border-white/[0.08]">
        {/* Secondary: Later or Details */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onLater}
            disabled={isInstalling}
            className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 font-mono text-[11px] font-bold text-white/70 transition hover:bg-white/10 hover:text-white active:scale-95 disabled:opacity-50"
          >
            <Clock className="h-3.5 w-3.5 text-graphite" /> LATER
          </button>

          {!isDownloading && !isReady && (
            <button
              type="button"
              onClick={onViewDetails}
              className="flex items-center gap-1 rounded-xl border border-white/10 bg-panel px-3 py-2 font-mono text-[11px] font-bold text-white/80 transition hover:bg-white/15 hover:text-white active:scale-95"
            >
              DETAILS <ArrowRight className="h-3.5 w-3.5 text-cyan-400" />
            </button>
          )}
        </div>

        {/* Primary Action Button */}
        {!isDownloading && (
          <button
            type="button"
            onClick={onUpdateNow}
            disabled={isInstalling}
            className="flex items-center gap-2 rounded-xl border px-4 py-2 font-mono text-xs font-black tracking-wider text-black shadow-lg transition-all hover:scale-105 active:scale-95 disabled:opacity-50"
            style={{
              borderColor: isReady ? 'rgba(52, 211, 153, 0.8)' : isError ? 'rgba(244, 63, 94, 0.8)' : `${palette.lamp}`,
              background: isReady
                ? 'linear-gradient(135deg, #34d399 0%, #059669 100%)'
                : isError
                ? 'linear-gradient(135deg, #f43f5e 0%, #e11d48 100%)'
                : `linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)`,
              boxShadow: isReady
                ? '0 0 20px rgba(52, 211, 153, 0.5)'
                : isError
                ? '0 0 20px rgba(244, 63, 94, 0.5)'
                : `0 0 20px ${palette.lampGlow || 'rgba(6,182,212,0.5)'}`,
            }}
          >
            {isReady ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 text-black" />
                RESTART &amp; APPLY
              </>
            ) : isError ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 text-white" />
                TRY AGAIN
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5 text-black" />
                UPDATE NOW
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
};
