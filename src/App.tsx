import React, { useState, useMemo, useEffect, useRef, Suspense, lazy } from 'react';
import { useAssistant } from './hooks/useAssistant';
import { useWakeWord } from './hooks/useWakeWord';
// Lazy-load SeraOrb — it's the only consumer of `three` (~600kB), and we
// don't want to pay that cost on initial paint when the user lands on the
// page (especially on slow networks / low-end devices). Combined with
// `manualChunks: { three: ['three'] }` in vite.config.ts, this lets the
// browser cache three.js independently and load it in the background
// after first paint.
const SeraOrb = lazy(() => import('./components/AssistantOrb/SeraOrb').then((m) => ({ default: m.SeraOrb })));
import { MicControl } from './components/MicrophoneButton/MicControl';
import { SeraHeader } from './components/Header/SeraHeader';
import { ChatStream } from './components/ChatStream/ChatStream';
import { TranscriptDrawer } from './components/TranscriptDrawer/TranscriptDrawer';
import { SettingsModal } from './components/SettingsModal/SettingsModal';
import { BrowserActionBanner } from './components/BrowserActionBanner/BrowserActionBanner';
import { ScreenShareDock } from './components/ScreenShare/ScreenShareDock';
import { getPaletteConfig } from './config/palettes';
import { DiagnosticsModal } from './components/DiagnosticsModal/DiagnosticsModal';
import { StartupLauncherModal } from './components/StartupLauncherModal/StartupLauncherModal';
import { UninstallModal } from './components/UninstallModal/UninstallModal';
import { ModeSwitchState } from './components/MicrophoneButton/MicControl';
import type { AssistantSettings } from './types';
// Build-time constant from package.json — used to re-show the startup wizard
// once per app version (localStorage survives reinstalls, so the old
// startupComplete flag alone made the wizard unreachable on fresh installs).
import { version as APP_VERSION } from '../package.json';

export default function App() {
  const {
    state,
    errorMessage,
    settings,
    updateSettings,
    transcripts,
    toolLogs,
    activeBrowserAction,
    dismissBrowserAction,
    visualizerData,
    toggleSession,
    interrupt,
    startSession,
    sendTextMessage,
    sendTextOrWake,
    clearHistory,
    isScreenSharing,
    stopScreenShare,
    screenShare,
    isConnected,
    diagnostics,
    sleepMode,
    isUninstallRequested,
    setIsUninstallRequested,
  } = useAssistant();

  // Hands-free "Hey Sera" or "Sera" continuous wake word listener.
  // DISABLED while SERA is in full sleep (user said "full quit") — that is
  // the guarantee that she can never interrupt again until clicked/typed to.
  const isDesktop = Boolean(window.seraDesktop?.isDesktop);
  const { permissionGranted, requestPermission, speechStatus, speechError, wakeDiagnostics, isListeningForWake } = useWakeWord({
    // Wake word ON by default; user can disable it in Settings → AUDIO.
    enabled: settings.wakeWordEnabled !== false && !sleepMode && !isConnected && state !== 'connecting' && state !== 'wake_word_detected',
    onWake: (prompt) => startSession(prompt),
  });

  // ── Wake-status chip model ─────────────────────────────
  // v1.6.7: "why doesn't the wake word work?" is now answered ON SCREEN.
  // Every state the listener can be in gets a visible, honest label.
  const wakeBlockReason = (() => {
    if (settings.wakeWordEnabled === false) return 'OFF IN SETTINGS';
    if (sleepMode) return 'FULL SLEEP';
    if (isConnected || state === 'connecting' || state === 'wake_word_detected') return 'SESSION LIVE';
    if (speechStatus === 'MIC_DENIED' || permissionGranted === false) return 'MIC BLOCKED';
    if (speechStatus === 'NETWORK') return 'NO INTERNET';
    if (speechStatus === 'AUDIO_BUSY') return 'MIC BUSY';
    if (speechStatus === 'ERROR') return 'ENGINE ERROR';
    return null;
  })();
  const wakeHint = (() => {
    if (settings.wakeWordEnabled === false) return 'Wake word is disabled — turn it back on in Settings → MIC & SPEAKERS → Wake Word.';
    if (sleepMode) return 'You told SERA to full quit. By design she stays silent until you click her mic button or type a message.';
    if (isConnected || state === 'connecting' || state === 'wake_word_detected') return 'Wake word pauses automatically while a session is live.';
    if (speechStatus === 'MIC_DENIED' || permissionGranted === false) return 'The browser blocked the microphone — click the mic button and ALLOW the mic.';
    if (speechStatus === 'NETWORK') return 'Chrome\u2019s speech service is unreachable — wake word needs internet. Local-mode sessions still work.';
    if (speechStatus === 'AUDIO_BUSY') return 'The microphone is busy (another app or a session is using it).';
    if (speechStatus === 'ERROR') return speechError || 'Wake engine error — reopen the page to restart it.';
    return 'Listens on your Windows default microphone — just say "Hey Sera" (or Sera / wake up).';
  })();

  const openDesktopMode = () => {
    console.log('[DESKTOP_MODE_REQUESTED]');
    void fetch('/api/desktop/launch', { method: 'POST' });
  };

  // Startup wizard (spec A): first launch only, stored in settings.
  // v1.8.4: ALSO re-shows once per app VERSION. Electron's userData (which
  // backs localStorage) is keyed by app name, NOT by install folder — so a
  // "fresh" SERA install inherited startupComplete=true from the previous
  // install and the mode-selection screen + setup instructions never
  // appeared. Completing the wizard stamps the version; a newer build shows
  // it exactly once more.
  const showLauncher = !settings.startupComplete || settings.startupCompletedVersion !== APP_VERSION;
  const handleLauncherComplete = (partial: Partial<AssistantSettings>) => {
    updateSettings({ ...partial, startupCompletedVersion: APP_VERSION });
  };

  // ── Mode Switch Loading Timer State ──
  const [modeSwitchState, setModeSwitchState] = useState<ModeSwitchState | null>(null);
  const switchTimerRef = useRef<NodeJS.Timeout | null>(null);

  const runMode = settings.runMode === 'local' ? 'local' : 'online';
  const handleToggleRunMode = () => {
    if (modeSwitchState) return;
    const next = runMode === 'local' ? 'online' : 'local';
    const totalDuration = next === 'online' ? 2.2 : 1.8;
    const label = next === 'online' ? 'CONNECTING TO GEMINI...' : 'INITIALIZING OLLAMA ENGINE...';

    const startTime = Date.now();
    const durationMs = totalDuration * 1000;

    setModeSwitchState({
      targetMode: next,
      totalSeconds: totalDuration,
      remainingSeconds: totalDuration,
      progress: 0,
      label,
    });

    if (switchTimerRef.current) clearInterval(switchTimerRef.current);

    switchTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remainingMs = Math.max(0, durationMs - elapsed);
      const remainingSec = remainingMs / 1000;
      const progress = Math.min(100, Math.round((elapsed / durationMs) * 100));

      if (remainingMs <= 0) {
        if (switchTimerRef.current) clearInterval(switchTimerRef.current);
        switchTimerRef.current = null;
        updateSettings({ runMode: next });
        setModeSwitchState(null);
        void fetch('/api/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: next }),
        }).catch(() => undefined);
      } else {
        setModeSwitchState({
          targetMode: next,
          totalSeconds: totalDuration,
          remainingSeconds: remainingSec,
          progress,
          label,
        });
      }
    }, 100);
  };
  const reopenLauncher = () => {
    // Relaunch the wizard but keep previous choices as defaults.
    updateSettings({ startupComplete: false });
  };

  const [isChatOpen, setIsChatOpen] = useState(true);
  const [isTranscriptsOpen, setIsTranscriptsOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'transcripts' | 'tools'>('transcripts');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'atmosphere' | 'audio' | 'voice' | 'mypc' | 'memory' | 'speakers' | 'keys' | 'models'>('atmosphere');
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isUninstallOpen, setIsUninstallOpen] = useState(false);

  // Synchronize voice-command or text-command triggered uninstallation intent
  useEffect(() => {
    if (isUninstallRequested) {
      setIsUninstallOpen(true);
    }
  }, [isUninstallRequested]);

  // v1.8.4: reachable entry point — the settings modal's MY PC tab offers
  // "Reopen setup wizard" (mode selection + Ollama instructions). Previously
  // reopenLauncher existed but was wired to NOTHING, so a user who completed
  // the wizard once could never see the instructions again.
  const openSetupWizardFromSettings = () => {
    setIsSettingsOpen(false);
    reopenLauncher();
  };

  const openFullHistory = () => {
    setDrawerTab('transcripts');
    setIsTranscriptsOpen(true);
  };
  const openToolLogs = () => {
    setDrawerTab('tools');
    setIsTranscriptsOpen(true);
  };
  const openVoiceSettings = () => {
    setSettingsTab('audio');
    setIsSettingsOpen(true);
  };

  const activePalette = useMemo(
    () => getPaletteConfig(settings.palette, settings.customColor),
    [settings.palette, settings.customColor],
  );
  const isLightMode = settings.themeMode === 'light';

  // Toggle document body class for light/dark theme
  useEffect(() => {
    if (isLightMode) {
      document.documentElement.classList.add('theme-light');
      document.body.classList.add('theme-light');
    } else {
      document.documentElement.classList.remove('theme-light');
      document.body.classList.remove('theme-light');
    }
  }, [isLightMode]);

  const handleToggleTheme = () => {
    updateSettings({ themeMode: isLightMode ? 'dark' : 'light' });
  };

  const isSpeaking = state === 'speaking';
  const isListening = state === 'listening';
  const energyLevel = isSpeaking ? visualizerData.speakerLevel : isListening ? visualizerData.micLevel : 0;

  return (
    <div
      className={`relative isolate z-0 flex min-h-screen w-full flex-col justify-between overflow-x-hidden bg-bg font-sans text-ink transition-colors duration-300 ${
        isLightMode ? 'theme-light' : ''
      }`}
      style={{
        ['--lamp' as string]: activePalette.lamp,
        ['--lamp-glow' as string]: activePalette.lampGlow || 'rgba(0, 229, 255, 0.4)',
      }}
    >
      {/* Dynamic Ambient Cosmic Nebula Radiance (GPU Accelerated) */}
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-1000 select-none transform-gpu"
        style={{ opacity: isConnected ? 0.9 : 0.65 }}
        aria-hidden="true"
      >
        {/* Top Radial Glow */}
        <div
          className="absolute -top-40 left-1/2 h-[600px] w-[600px] -translate-x-1/2 rounded-full blur-[80px] transition-transform duration-300 transform-gpu will-change-transform"
          style={{
            background: activePalette.lamp,
            transform: `translate3d(-50%, 0, 0) scale(${1 + energyLevel * 0.3})`,
            opacity: isLightMode ? 0.09 : 0.16,
          }}
        />
        {/* Bottom Secondary Nebula */}
        {activePalette.secondary && (
          <div
            className="absolute -bottom-40 left-1/3 h-[550px] w-[550px] -translate-x-1/2 rounded-full blur-[80px] transition-transform duration-300 transform-gpu will-change-transform"
            style={{
              background: activePalette.secondary,
              transform: `translate3d(-50%, 0, 0) scale(${1 + energyLevel * 0.25})`,
              opacity: isLightMode ? 0.07 : 0.14,
            }}
          />
        )}
        {/* Tertiary Accent Glow */}
        {activePalette.tertiary && (
          <div
            className="absolute top-1/3 right-0 h-[450px] w-[450px] translate-x-1/4 rounded-full blur-[80px] transition-transform duration-300 transform-gpu will-change-transform"
            style={{
              background: activePalette.tertiary,
              transform: `translate3d(0, 0, 0) scale(${1 + energyLevel * 0.2})`,
              opacity: isLightMode ? 0.05 : 0.10,
            }}
          />
        )}
      </div>

      {/* v1.7.0 — Bottom-left floating stack: server-side LIVE badge, the
          browser Screen Share dock (Share Screen button / preview +
          controls), and the wake-word status chip. One column so the three
          floats can NEVER overlap — position and styles are unchanged for
          each element; only their stacking is now explicit. */}
      {!showLauncher && (
        <div className="fixed bottom-3 left-3 z-30 flex flex-col items-start gap-3">
          {/* v1.6.10 — LIVE screen share badge (Discord-style). Red pulse dot
              + one-click stop. */}
          {isScreenSharing && (
            <div
              className="flex items-center gap-2 rounded-full border border-red-500/60 bg-red-950/70 px-3 py-1 font-mono text-[9px] font-bold tracking-wider text-red-300 shadow-lg shadow-red-900/30 backdrop-blur-sm"
              title="SERA is watching your screen live (~1 frame per second, only when the screen changes). Click STOP to end it."
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
              <span>LIVE · SEEING YOUR SCREEN</span>
              <button
                onClick={stopScreenShare}
                className="ml-0.5 rounded-full border border-red-500/50 px-1.5 py-px text-[8px] text-red-200 transition-colors hover:bg-red-500/30"
              >
                STOP
              </button>
            </div>
          )}

          {/* v1.7.0 — REAL browser screen sharing (getDisplayMedia): Share
              Screen button, live preview, Screen Vision mode, pause / resume /
              switch / stop controls. */}
          <ScreenShareDock
            share={screenShare}
            paletteId={settings.palette}
            customColor={settings.customColor}
          />

          {/* Wake-word status chip — on-screen answer to "why doesn't wake work?" */}
          <div
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[8px] font-bold tracking-wider backdrop-blur-sm ${
              wakeBlockReason
                ? 'border-line bg-panel/80 text-graphite'
                : 'border-emerald-500/40 bg-panel/80 text-emerald-500'
            }`}
            title={wakeHint}
          >
            {wakeBlockReason ? (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-white/25" />
                <span>WAKE OFF · {wakeBlockReason}</span>
              </>
            ) : (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                <span>{isListeningForWake ? 'WAKE · "HEY SERA"' : 'WAKE · STARTING'}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Browser Action Execution Banner */}
      <BrowserActionBanner
        action={activeBrowserAction}
        onDismiss={dismissBrowserAction}
      />

      {/* Console Header */}
      <SeraHeader
        state={state}
        paletteId={settings.palette}
        customColor={settings.customColor}
        themeMode={settings.themeMode || 'dark'}
        onToggleTheme={handleToggleTheme}
        runMode={runMode}
        onToggleRunMode={handleToggleRunMode}
        modeSwitchState={modeSwitchState}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
        onOpenTranscripts={openFullHistory}
        transcriptCount={transcripts.length + toolLogs.length}
      />

      {/* Main Celestial Cosmic Viewport */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 py-4">
        <Suspense fallback={<div className="h-[60vh] w-full" aria-hidden="true" />}>
          <SeraOrb
            state={state}
            visualizerData={visualizerData}
            paletteId={settings.palette}
            customColor={settings.customColor}
          />
        </Suspense>
      </main>

      {/* Right-Side Borderless Floating Chat Stream & Type Input (With Top-Fading Disappearing Mask) */}
      <ChatStream
        transcripts={transcripts}
        toolLogs={toolLogs}
        onSendMessage={sendTextOrWake}
        onClearHistory={clearHistory}
        onOpenFullHistory={openFullHistory}
        onOpenTools={openToolLogs}
        paletteId={settings.palette}
        customColor={settings.customColor}
        isSpeaking={isSpeaking}
        isConnected={isConnected}
        state={state}
        errorMessage={errorMessage}
        isOpen={isChatOpen}
        onToggleOpen={() => setIsChatOpen((prev) => !prev)}
      />

      {/* Unified Cyber-Voice Console Deck (Waveform + Telemetry + Controls) */}
      <footer className="relative z-20 mx-auto flex w-full max-w-lg flex-col items-center px-6 pt-2 pb-8">
        <MicControl
          state={state}
          visualizerData={visualizerData}
          errorMessage={errorMessage}
          paletteId={settings.palette}
          customColor={settings.customColor}
          permissionGranted={permissionGranted}
          isDesktop={isDesktop}
          speechStatus={speechStatus}
          speechError={speechError}
          sleepMode={sleepMode}
          modeSwitchState={modeSwitchState}
          onRequestPermission={requestPermission}
          onOpenDesktop={openDesktopMode}
          onOpenVoiceSettings={openVoiceSettings}
          onInterrupt={interrupt}
          onToggleTalk={toggleSession}
        />
      </footer>

      {/* Slide-out Captions & Tool Activity Drawer (Accessible fallback) */}
      <TranscriptDrawer
        isOpen={isTranscriptsOpen}
        onClose={() => setIsTranscriptsOpen(false)}
        transcripts={transcripts}
        toolLogs={toolLogs}
        onSendMessage={sendTextOrWake}
        onClearHistory={clearHistory}
        isConnected={isConnected}
        initialTab={drawerTab}
      />

      {/* Diagnostics Telemetry Panel */}
      <DiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
        state={state}
        isConnected={isConnected}
        errorMessage={errorMessage}
        diagnostics={diagnostics}
        toolLogs={toolLogs}
        wakeDiagnostics={wakeDiagnostics}
      />

      {/* Console Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdateSettings={updateSettings}
        initialTab={settingsTab}
        onOpenSetupWizard={openSetupWizardFromSettings}
        onOpenUninstall={() => {
          setIsSettingsOpen(false);
          setIsUninstallOpen(true);
        }}
      />

      {/* Secure Uninstallation & Data Protection Modal */}
      <UninstallModal
        isOpen={isUninstallOpen}
        onClose={() => {
          setIsUninstallOpen(false);
          setIsUninstallRequested(false);
        }}
        paletteId={settings.palette}
        customColor={settings.customColor}
      />

      {/* Startup Launcher Wizard — dual-mode launch (spec A) */}
      {showLauncher && (
        <StartupLauncherModal onComplete={handleLauncherComplete} />
      )}
    </div>
  );
}
