import React from 'react';
import { Settings, MessageSquare, Activity, Sun, Moon, Zap, Cloud, Power } from 'lucide-react';
import { AssistantStateType, ColorPaletteId } from '../../types';
import { getPaletteConfig } from '../../config/palettes';

interface SeraHeaderProps {
  state: AssistantStateType;
  paletteId?: ColorPaletteId;
  customColor?: string;
  themeMode?: 'dark' | 'light' | 'system';
  onToggleTheme?: () => void;
  /** Current engine mode: 'local' (offline Ollama) or 'online' (Gemini Live). */
  runMode?: 'online' | 'local';
  /** 1-click Local ⇄ Online switcher (spec A.2). */
  onToggleRunMode?: () => void;
  onOpenSettings: () => void;
  onOpenDiagnostics: () => void;
  onOpenTranscripts: () => void;
  transcriptCount: number;
}

export const SeraHeader: React.FC<SeraHeaderProps> = React.memo(({
  state,
  paletteId,
  customColor,
  themeMode = 'dark',
  onToggleTheme,
  runMode = 'online',
  onToggleRunMode,
  onOpenSettings,
  onOpenDiagnostics,
  onOpenTranscripts,
  transcriptCount,
}) => {
  const isConnected = state === 'listening' || state === 'speaking';
  const isError = state === 'error';
  const isWake = state === 'wake_word_detected';
  const isConnecting = state === 'connecting';
  const palette = getPaletteConfig(paletteId, customColor);

  const dotColor = isError
    ? '#ff3b5c'
    : isWake
    ? '#ffd166'
    : isConnecting || isConnected
    ? palette.lamp
    : '#10b981'; // Calm emerald in standby

  const stateTag = isError
    ? 'OFFLINE'
    : isWake
    ? 'WAKING UP'
    : isConnecting
    ? 'CONNECTING'
    : state === 'speaking'
    ? 'TRANSMITTING'
    : state === 'listening'
    ? 'LIVE'
    : 'STANDBY';

  const iconBtn = `
    relative inline-flex h-9 w-9 items-center justify-center rounded-xl
    border border-white/[0.06] bg-white/[0.03] text-white/50 backdrop-blur-md
    transition-all duration-200 hover:border-white/20 hover:bg-white/[0.08] hover:text-white/90
    active:scale-95 shadow-sm
  `;

  return (
    <header className="relative z-30 w-full">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 pt-5 pb-3">

        {/* ── Brand Capsule Badge ── */}
        <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-2 backdrop-blur-xl shadow-lg transition-all duration-300 hover:border-white/20">
          <span
            className="font-sans text-[15px] font-black tracking-[0.28em] text-transparent bg-clip-text"
            style={{
              backgroundImage: `linear-gradient(135deg, #ffffff 40%, ${palette.lamp} 100%)`,
            }}
          >
            SERA
          </span>

          <span className="h-3 w-[1px] bg-white/20" />

          {/* Micro status indicator */}
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {(isConnected || isConnecting || isWake) && (
                <span
                  className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                  style={{ background: dotColor }}
                />
              )}
              <span
                className="relative inline-flex h-2 w-2 rounded-full shadow-[0_0_8px] transition-colors duration-500"
                style={{ background: dotColor, boxShadow: `0 0 8px ${dotColor}` }}
              />
            </span>

            <span className="font-mono text-[9px] font-bold tracking-[0.18em] text-white/60 uppercase">
              {stateTag}
            </span>
          </div>
        </div>

        {/* ── Action Toolbar ── */}
        <div className="flex items-center gap-2">
          {/* 1-Click Mode Switcher (Local ⇄ Online) */}
          {onToggleRunMode && (
            <button
              type="button"
              onClick={onToggleRunMode}
              aria-label={`Switch to ${runMode === 'local' ? 'online' : 'local'} mode`}
              className="group relative inline-flex h-9 items-center gap-1.5 rounded-xl border px-2.5 backdrop-blur-md transition-all duration-200 active:scale-95"
              style={{
                borderColor: runMode === 'local' ? 'rgba(52, 211, 153, 0.35)' : 'rgba(34, 211, 238, 0.35)',
                background: runMode === 'local' ? 'rgba(52, 211, 153, 0.08)' : 'rgba(34, 211, 238, 0.08)',
              }}
              title={runMode === 'local' ? 'Local Mode (100% offline) — click to switch to Online' : 'Online Mode (Gemini Live) — click to switch to Local'}
            >
              {runMode === 'local' ? (
                <Zap className="h-3.5 w-3.5 text-emerald-300" />
              ) : (
                <Cloud className="h-3.5 w-3.5 text-cyan-300" />
              )}
              <span
                className="font-mono text-[9px] font-bold tracking-[0.16em] uppercase"
                style={{ color: runMode === 'local' ? 'rgb(167, 243, 208)' : 'rgb(165, 243, 252)' }}
              >
                {runMode}
              </span>
            </button>
          )}

          {onToggleTheme && (
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label="Toggle theme"
              className={iconBtn}
              title={themeMode === 'light' ? 'Switch to Obsidian Dark' : 'Switch to Ceramic Light'}
            >
              {themeMode === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
          )}

          <button
            type="button"
            onClick={onOpenTranscripts}
            aria-label="Captions"
            className={iconBtn}
            title="Conversation Logs"
          >
            <MessageSquare className="h-4 w-4" />
            {transcriptCount > 0 && (
              <span
                className="absolute right-0 top-0 flex h-4 min-w-4 translate-x-1/4 -translate-y-1/4 items-center justify-center rounded-full px-1 font-mono text-[8px] font-bold text-white shadow-md ring-1 ring-black/40"
                style={{ background: palette.lamp }}
              >
                {transcriptCount > 99 ? '99+' : transcriptCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onOpenDiagnostics}
            aria-label="Diagnostics"
            className={iconBtn}
            title="Audio & System Diagnostics"
          >
            <Activity className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className={iconBtn}
            title="Console Configuration"
          >
            <Settings className="h-4 w-4" />
          </button>

          {/* Quit SERA — desktop app only. One click stops the assistant AND
              the background server, for anyone who does not want to hunt
              for the console window. */}
          {typeof window !== 'undefined' && window.seraDesktop?.quitApp && (
            <button
              type="button"
              onClick={() => { void window.seraDesktop?.quitApp?.(); }}
              aria-label="Quit SERA"
              className={`${iconBtn} hover:!border-rose-500/50 hover:!text-rose-300`}
              title="Quit SERA — stops the assistant and the background server"
            >
              <Power className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
});
