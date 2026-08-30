import React from 'react';
import { Sparkles, Download, ArrowRight, X, Clock, CheckCircle2 } from 'lucide-react';
import { UpdateState, ColorPaletteId } from '../../types';
import { getPaletteConfig } from '../../config/palettes';

interface UpdateNotificationToastProps {
  isVisible: boolean;
  updateState: UpdateState;
  paletteId?: ColorPaletteId;
  customColor?: string;
  onUpdateNow: () => void;
  onViewDetails: () => void;
  onLater: () => void;
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
  const version = updateState.info.latestVersion || 'New Version';
  const isDownloading = updateState.status === 'downloading';
  const isReady = updateState.status === 'ready-to-install';

  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-cyan-500/30 bg-[#0d0f17]/95 p-4 text-white shadow-[0_16px_50px_rgba(0,229,255,0.25)] backdrop-blur-2xl animate-slide-in-right"
      style={{
        borderColor: `${palette.lamp}66`,
        boxShadow: `0 16px 50px rgba(0,0,0,0.8), 0 0 25px ${palette.lampGlow || 'rgba(0, 229, 255, 0.2)'}`,
      }}
    >
      {/* Header & Dismiss Button */}
      <div className="flex items-center justify-between pb-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
          </span>
          <span className="font-mono text-[10px] font-black tracking-[0.18em] text-cyan-300 uppercase">
            {isReady ? 'UPDATE READY TO INSTALL' : isDownloading ? 'UPDATING SERA...' : 'UPDATE AVAILABLE'}
          </span>
        </div>

        <button
          type="button"
          onClick={onLater}
          className="flex h-6 w-6 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/50 transition hover:bg-white/10 hover:text-white"
          title="Dismiss (Later)"
          aria-label="Dismiss update notification"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="flex items-start gap-3 py-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 shadow-inner"
          style={{ background: `linear-gradient(135deg, ${palette.lamp}25 0%, rgba(0,0,0,0.6) 100%)` }}
        >
          {isReady ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-400" />
          ) : (
            <Sparkles className="h-5 w-5" style={{ color: palette.lamp }} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="font-sans text-xs font-bold text-white">SERA {version}</h4>
            <span className="rounded-md border border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-cyan-300">
              NEW
            </span>
          </div>
          <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-white/60 line-clamp-2">
            {isReady
              ? 'Update has been verified and is ready to apply.'
              : updateState.info.releaseName || 'Performance enhancements and stability updates ready.'}
          </p>
        </div>
      </div>

      {/* Download Progress Bar if active */}
      {isDownloading && (
        <div className="space-y-1 pb-3">
          <div className="flex items-center justify-between font-mono text-[9px] text-white/70">
            <span>Downloading update...</span>
            <span className="font-bold text-cyan-300">{updateState.progress.percent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/60 border border-white/10">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.max(4, updateState.progress.percent)}%`,
                background: palette.lamp,
                boxShadow: `0 0 8px ${palette.lamp}`,
              }}
            />
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-2 pt-1 border-t border-white/[0.06]">
        <button
          type="button"
          onClick={onLater}
          className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 font-mono text-[10px] font-bold text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          <Clock className="h-3 w-3" /> LATER
        </button>

        <button
          type="button"
          onClick={onViewDetails}
          className="flex items-center gap-1 rounded-xl border border-white/15 bg-white/10 px-3 py-1.5 font-mono text-[10px] font-bold text-white/90 transition hover:bg-white/20 hover:text-white"
        >
          DETAILS <ArrowRight className="h-3 w-3" />
        </button>

        {!isDownloading && (
          <button
            type="button"
            onClick={onUpdateNow}
            className="flex items-center gap-1.5 rounded-xl border px-3 py-1.5 font-mono text-[10px] font-black tracking-wider text-white shadow-md transition-all hover:scale-105 active:scale-95"
            style={{
              borderColor: `${palette.lamp}88`,
              background: `linear-gradient(135deg, ${palette.lamp} 0%, rgba(10,12,18,0.9) 100%)`,
              boxShadow: `0 0 15px ${palette.lampGlow || 'rgba(0,229,255,0.3)'}`,
            }}
          >
            <Download className="h-3 w-3" /> {isReady ? 'RESTART' : 'UPDATE NOW'}
          </button>
        )}
      </div>
    </div>
  );
};
