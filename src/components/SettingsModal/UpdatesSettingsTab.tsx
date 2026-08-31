import React, { useState, useEffect } from 'react';
import {
  Download,
  RefreshCw,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  Zap,
  ArrowUpCircle,
  FileText,
  Loader2,
  HardDrive,
} from 'lucide-react';
import { UpdateState, AssistantSettings } from '../../types';
import { formatBytes } from '../../local/pullClient';

interface UpdatesSettingsTabProps {
  updateState: UpdateState;
  settings: AssistantSettings;
  onUpdateSettings: (partial: Partial<AssistantSettings>) => void;
  onCheckForUpdates: () => Promise<any>;
  onDownloadUpdate: () => Promise<void>;
  onCancelDownload: () => Promise<void>;
  onInstallAndRestart: () => Promise<void>;
}

export const UpdatesSettingsTab: React.FC<UpdatesSettingsTabProps> = ({
  updateState,
  settings,
  onUpdateSettings,
  onCheckForUpdates,
  onDownloadUpdate,
  onCancelDownload,
  onInstallAndRestart,
}) => {
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { status, info, progress, errorMessage } = updateState;
  const isDownloading = status === 'downloading';
  const isVerifying = status === 'verifying';
  const isReady = status === 'ready-to-install';
  const isInstalling = status === 'installing' || status === 'restarting';
  const isUpToDate = status === 'up-to-date' || (!info.hasUpdate && status !== 'error' && status !== 'checking');

  // Auto-sync status on mount
  useEffect(() => {
    void onCheckForUpdates();
  }, [onCheckForUpdates]);

  const handleCheck = async () => {
    setChecking(true);
    setActionError(null);
    try {
      await onCheckForUpdates();
    } catch (e: any) {
      setActionError(e?.message || 'Failed to check for updates');
    } finally {
      setChecking(false);
    }
  };

  const handleUpdateClick = async () => {
    setActionError(null);
    if (isReady) {
      await onInstallAndRestart();
    } else {
      await onDownloadUpdate();
    }
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const updateBehavior = settings.updateBehavior || 'auto_download';

  return (
    <div className="space-y-6 animate-fade-up">
      {/* ── 1. Version & Status Overview Card ── */}
      <div className="space-y-4 rounded-3xl border border-line bg-paper p-5 shadow-sm">
        <div className="flex items-center justify-between border-b border-line/60 pb-3">
          <div className="flex items-center gap-2">
            <ArrowUpCircle className="h-4 w-4 text-cyan-500" />
            <span className="font-mono text-xs font-bold tracking-[0.14em] text-ink uppercase">
              SERA Software Updates
            </span>
          </div>
          <button
            type="button"
            onClick={handleCheck}
            disabled={checking || isDownloading || isInstalling}
            className="flex items-center gap-1.5 rounded-xl border border-line bg-panel px-3 py-1 font-mono text-[10px] font-bold text-graphite transition hover:text-ink active:scale-95 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${checking ? 'animate-spin' : ''}`} />
            {checking ? 'CHECKING...' : 'CHECK FOR UPDATES'}
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {/* Current Version */}
          <div className="flex flex-col gap-1 rounded-2xl border border-line/70 bg-panel/60 p-3.5">
            <span className="font-mono text-[9px] text-graphite uppercase tracking-wider">Current Version</span>
            <div className="font-mono text-base font-black text-ink">{info.currentVersion}</div>
            <span className="font-mono text-[8.5px] text-graphite">Installed on this machine</span>
          </div>

          {/* Latest Available Version */}
          <div className="flex flex-col gap-1 rounded-2xl border border-line/70 bg-panel/60 p-3.5">
            <span className="font-mono text-[9px] text-graphite uppercase tracking-wider">Latest Release</span>
            <div className="font-mono text-base font-black text-cyan-400">
              {info.latestVersion || info.currentVersion}
            </div>
            <span className="font-mono text-[8.5px] text-graphite">
              {info.hasUpdate ? 'New version available' : 'Up to date'}
            </span>
          </div>

          {/* Status Badge */}
          <div className="flex flex-col justify-between gap-1 rounded-2xl border border-line/70 bg-panel/60 p-3.5">
            <span className="font-mono text-[9px] text-graphite uppercase tracking-wider">Status</span>
            <div className="flex items-center gap-1.5">
              {isUpToDate ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> UP TO DATE
                </span>
              ) : isReady ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400 animate-pulse">
                  <CheckCircle2 className="h-3 w-3" /> READY TO INSTALL
                </span>
              ) : isDownloading ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/15 px-2.5 py-0.5 font-mono text-[10px] font-bold text-cyan-300">
                  <Loader2 className="h-3 w-3 animate-spin" /> DOWNLOADING
                </span>
              ) : info.hasUpdate ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-0.5 font-mono text-[10px] font-bold text-amber-300">
                  <Sparkles className="h-3 w-3" /> UPDATE READY
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-0.5 font-mono text-[10px] font-bold text-graphite">
                  IDLE
                </span>
              )}
            </div>
            <span className="font-mono text-[8.5px] text-graphite">
              Last checked: {formatTime(info.lastChecked)}
            </span>
          </div>
        </div>

        {/* Error Notification */}
        {(errorMessage || actionError) && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300 font-mono">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
            <span>{errorMessage || actionError}</span>
          </div>
        )}
      </div>

      {/* ── 2. Active Download Progress Bar Card ── */}
      {(isDownloading || isVerifying || isReady) && (
        <div className="space-y-3 rounded-3xl border border-cyan-500/30 bg-paper p-5 shadow-lg shadow-cyan-950/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Download className="h-4 w-4 text-cyan-400 animate-bounce" />
              <span className="font-mono text-xs font-bold text-ink uppercase">
                {isVerifying
                  ? 'Verifying Package Integrity...'
                  : isReady
                  ? 'Update Ready for Safe Restart'
                  : `Downloading SERA ${info.latestVersion}...`}
              </span>
            </div>
            {isDownloading && (
              <button
                type="button"
                onClick={onCancelDownload}
                className="rounded-lg border border-line bg-panel px-2 py-0.5 font-mono text-[9px] text-graphite hover:text-red-400"
              >
                CANCEL
              </button>
            )}
          </div>

          {/* Progress Metrics */}
          <div className="flex items-center justify-between font-mono text-[10px] text-graphite">
            <span>
              {formatBytes(progress.bytesDownloaded)} / {progress.totalBytes ? formatBytes(progress.totalBytes) : 'Unknown size'}
            </span>
            <span className="font-bold text-ink">
              {isReady ? '100%' : `${progress.percent}%`}
            </span>
          </div>

          {/* Visual Progress Bar */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-panel border border-line">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isReady ? 'bg-emerald-500' : 'bg-gradient-to-r from-cyan-500 to-blue-500'
              }`}
              style={{ width: `${isReady ? 100 : Math.max(3, progress.percent)}%` }}
            />
          </div>

          {/* Speed and ETA */}
          {isDownloading && (
            <div className="flex items-center justify-between font-mono text-[9px] text-graphite">
              <span>Transfer speed: {formatBytes(progress.speedBytesPerSec)}/s</span>
              <span>
                {progress.etaSeconds !== null ? `Estimated time: ~${progress.etaSeconds}s` : 'Calculating ETA...'}
              </span>
            </div>
          )}

          {/* Ready to Restart Prompt */}
          {isReady && (
            <div className="pt-2">
              <p className="font-mono text-[10px] text-emerald-400">
                ✓ Package verified. SERA will gracefully shut down, install the update silently, and automatically restart.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── 3. What's New / Release Changelog Card ── */}
      {info.hasUpdate && info.releaseNotes && (
        <div className="space-y-3 rounded-3xl border border-line bg-paper p-5 shadow-sm">
          <div className="flex items-center gap-2 border-b border-line/60 pb-2">
            <FileText className="h-4 w-4 text-cyan-500" />
            <span className="font-mono text-xs font-bold tracking-wider text-ink uppercase">
              What's New in SERA {info.latestVersion}
            </span>
          </div>
          <div className="max-h-48 overflow-y-auto rounded-2xl border border-line/60 bg-panel/50 p-3.5 font-mono text-xs text-graphite whitespace-pre-wrap leading-relaxed">
            {info.releaseNotes}
          </div>
        </div>
      )}

      {/* ── 4. Update Policy Settings Card ── */}
      <div className="space-y-3 rounded-3xl border border-line bg-paper p-5 shadow-sm">
        <div className="flex items-center gap-2 border-b border-line/60 pb-2">
          <ShieldCheck className="h-4 w-4 text-cyan-500" />
          <span className="font-mono text-xs font-bold tracking-wider text-ink uppercase">
            Automatic Update Behavior
          </span>
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-3 cursor-pointer p-2 rounded-xl hover:bg-panel/50 transition">
            <input
              type="radio"
              name="updateBehavior"
              checked={updateBehavior === 'auto_download'}
              onChange={() => onUpdateSettings({ updateBehavior: 'auto_download' })}
              className="accent-cyan-500 h-4 w-4"
            />
            <div>
              <span className="block font-sans text-xs font-bold text-ink">
                Download automatically, install when I choose (Recommended)
              </span>
              <span className="block font-mono text-[9px] text-graphite">
                SERA quietly downloads new versions in the background and notifies you when ready to restart.
              </span>
            </div>
          </label>

          <label className="flex items-center gap-3 cursor-pointer p-2 rounded-xl hover:bg-panel/50 transition">
            <input
              type="radio"
              name="updateBehavior"
              checked={updateBehavior === 'ask'}
              onChange={() => onUpdateSettings({ updateBehavior: 'ask' })}
              className="accent-cyan-500 h-4 w-4"
            />
            <div>
              <span className="block font-sans text-xs font-bold text-ink">
                Ask before downloading
              </span>
              <span className="block font-mono text-[9px] text-graphite">
                Only notify me when an update is available without downloading until I click Update Now.
              </span>
            </div>
          </label>
        </div>
      </div>

      {/* ── 5. Main Action Button ── */}
      {info.hasUpdate && (
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={handleUpdateClick}
            disabled={isDownloading || isVerifying || isInstalling}
            className={`flex items-center gap-2 rounded-2xl px-6 py-3 font-mono text-xs font-black tracking-wider text-white shadow-lg transition hover:scale-105 active:scale-95 disabled:opacity-60 ${
              isReady
                ? 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600 shadow-emerald-500/30 animate-pulse text-emerald-950 font-black'
                : 'bg-gradient-to-r from-cyan-500 to-blue-600 shadow-cyan-500/25'
            }`}
          >
            {isInstalling ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>RESTARTING SERA TO APPLY UPDATE...</span>
              </>
            ) : isVerifying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>VERIFYING PACKAGE INTEGRITY...</span>
              </>
            ) : isDownloading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>DOWNLOADING ({progress.percent}%)...</span>
              </>
            ) : isReady ? (
              <>
                <RefreshCw className="h-4 w-4" />
                <span>RESTART & APPLY UPDATE NOW</span>
              </>
            ) : (
              <>
                <Download className="h-4 w-4" />
                <span>UPDATE NOW TO {info.latestVersion}</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
