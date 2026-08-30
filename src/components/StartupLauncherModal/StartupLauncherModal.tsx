import React, { useState, useCallback, useRef } from 'react';
import {
  Zap, Cloud, Cpu, MemoryStick, HardDrive, Monitor, CheckCircle2,
  AlertTriangle, Download, Loader2, ChevronRight, ShieldCheck, Wifi, RotateCw,
} from 'lucide-react';
import type { AssistantSettings } from '../../types';
import { runVerifiedPull, IDLE_VERIFIED_PULL, phaseLabel, type VerifiedPullState } from '../../local/modelPullClient';

/* ────────────────────────────────────────────────────────────────────
 * Types mirroring /api/local/hardware + /api/local/status
 * ──────────────────────────────────────────────────────────────────── */
interface HardwareReport {
  platform: string;
  cpu: { model: string; logicalCores: number; physicalCores: number | null };
  ram: { totalMB: number; freeMB: number };
  gpu: { name: string; vramTotalMB: number; vramFreeMB: number; driverVersion: string; cudaComputeCapability: string | null; cudaSupported: boolean } | null;
  tier: 'cuda-high' | 'cuda-mid' | 'cuda-low' | 'cpu-only';
  probeNotes: string[];
}

interface Recommendation {
  model: string;
  spec: { label: string; downloadMB: number; contextWindow: number; speedClass: string; strengths: string };
  rationale: string;
  alternative?: { model: string; label: string; rationale: string };
  budget: { vramAvailableMB: number; vramRequiredMB: number; fitsInVram: boolean; cpuFallback: boolean };
}

interface LocalStatus {
  ollama: { installed: boolean; running: boolean; version: string | null; installHint: string; baseUrl: string; probeNotes?: string[] };
  hardware: HardwareReport;
  recommendation: Recommendation;
  installedModels: Array<{ name: string; sizeBytes: number }>;
  recommendedModelInstalled: boolean;
  speech: { stt: { available: boolean; hint?: string }; tts: { available: boolean; hint?: string } };
}

interface ServerHealth {
  status: string;
  mode?: 'online' | 'local';
  hasApiKey?: boolean;
}

interface StartupLauncherModalProps {
  /** Called once when the user picks a mode and enters SERA. */
  onComplete: (settings: Partial<AssistantSettings>) => void;
}

type Phase = 'auditing' | 'choose' | 'pulling' | 'entering';

const fmtMB = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/**
 * SERA Startup Launcher — Interactive Dual-Mode Launch Wizard (spec A.1).
 *
 * Glassmorphic full-screen modal shown on app start:
 *  1. Auto-audits the local hardware (GPU / VRAM / CUDA / RAM / CPU).
 *  2. Recommends the best offline model and offers a 1-click pull with a
 *     live progress bar streamed from /api/local/pull.
 *  3. Lets the user enter Local Mode (100% offline) or Online Mode
 *     (high-speed cloud APIs).
 */
export const StartupLauncherModal: React.FC<StartupLauncherModalProps> = ({ onComplete }) => {
  // ALWAYS run the hardware audit, even when the user has a saved
  // preference. The audit powers the model recommendation, the Ollama
  // readiness panel and the guided local-setup instructions — skipping it
  // left first-run users (whose default runMode is now 'local') with a
  // status-less chooser and no setup guidance.
  const [phase, setPhase] = useState<Phase>('auditing');
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // v1.9.0 (BUG L2 FIX): the wizard used to end every pull stream with an
  // unconditional "Model ready ✓" — even when Ollama had failed. It now
  // uses the SAME verified flow as MY PC: stream → verify with Ollama's own
  // model list → only then "ready", with WHAT/WHY/FIX on failure.
  const [pull, setPull] = useState<VerifiedPullState>(IDLE_VERIFIED_PULL);
  const [enteredMode, setEnteredMode] = useState<'online' | 'local' | null>(null);
  const [hasServerKey, setHasServerKey] = useState<boolean | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const pullAbortRef = useRef<AbortController | null>(null);

  const runAudit = useCallback(async () => {
    setPhase('auditing');
    setAuditError(null);
    try {
      const [statusResponse, healthResponse] = await Promise.all([
        fetch('/api/local/status'),
        fetch('/api/health').catch(() => null),
      ]);
      if (healthResponse?.ok) {
        const health = (await healthResponse.json()) as ServerHealth;
        setHasServerKey(Boolean(health.hasApiKey));
      }
      if (!statusResponse.ok) throw new Error(`Server responded ${statusResponse.status}`);
      const data = (await statusResponse.json()) as LocalStatus;
      setStatus(data);
      setSelectedModel(data.recommendation.model);
      setPhase('choose');
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err));
      setPhase('choose');
    }
  }, []);

  /** Re-run the audit after the user installs/starts Ollama mid-wizard. */
  const recheck = useCallback(async () => {
    setRechecking(true);
    await runAudit();
    setRechecking(false);
  }, [runAudit]);

  // Kick off the audit on first mount.
  React.useEffect(() => {
    void runAudit();
  }, [runAudit]);

  /** 1-click model pull — shared verified flow (PREPARING→…→VERIFYING→READY). */
  const startPull = useCallback(async (model: string) => {
    const controller = new AbortController();
    pullAbortRef.current = controller;
    setPhase('pulling');
    try {
      const finalState = await runVerifiedPull(model, {
        signal: controller.signal,
        onUpdate: (s) => setPull(s),
      });
      // Refresh the audit so "recommended model installed" flips honestly.
      if (finalState.phase === 'ready') {
        void runAudit().then(() => setPhase('choose'));
      } else {
        setPhase('choose');
      }
    } catch (err) {
      // AbortError — the user backed out; reset quietly.
      if ((err as Error).name === 'AbortError') {
        setPull(IDLE_VERIFIED_PULL);
        setPhase('choose');
        return;
      }
      setPhase('choose');
    } finally {
      pullAbortRef.current = null;
    }
  }, [runAudit]);

  const enterMode = useCallback((mode: 'online' | 'local') => {
    setEnteredMode(mode);
    setPhase('entering');
    onComplete({
      runMode: mode,
      startupComplete: true,
      ...(mode === 'local' && selectedModel ? { localModel: selectedModel } : {}),
    });
  }, [onComplete, selectedModel]);

  const hardware = status?.hardware;
  const recommendation = status?.recommendation;
  const gpu = hardware?.gpu || null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/70 px-4 py-8 backdrop-blur-2xl">
      <div
        className="relative w-full max-w-3xl rounded-3xl border border-white/10 bg-white/[0.045] p-8 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.8)]"
        role="dialog"
        aria-modal="true"
        aria-label="SERA startup launcher"
        style={{ backdropFilter: 'blur(28px) saturate(140%)' }}
      >
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-white via-white to-cyan-300/80 bg-clip-text text-2xl font-black tracking-tight text-transparent">
              Welcome to SERA
            </h1>
            <p className="mt-1 text-sm text-white/50">Runs locally on your machine by default — or online when you need it.</p>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-lg font-black text-cyan-300 shadow-inner">
            S
          </div>
        </div>

        {/* Auditing phase */}
        {phase === 'auditing' && (
          <div className="flex flex-col items-center gap-4 py-14" data-testid="launcher-auditing">
            <Loader2 className="h-8 w-8 animate-spin text-cyan-300" />
            <p className="font-mono text-xs uppercase tracking-[0.25em] text-white/60">Auditing local hardware…</p>
            <p className="text-xs text-white/35">Inspecting GPU, VRAM, CUDA capability, RAM and CPU</p>
          </div>
        )}

        {auditError && phase === 'choose' && !status && (
          <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="text-xs text-amber-100/80">
              <p className="font-semibold">Hardware audit unavailable ({auditError})</p>
              <p className="mt-1 text-amber-100/50">You can still choose a mode — Local Mode will attempt setup when Ollama is reachable.</p>
            </div>
            <button type="button" onClick={() => void runAudit()} className="ml-auto rounded-lg border border-white/10 px-3 py-1.5 text-[11px] font-bold text-white/70 transition hover:bg-white/10">
              RETRY
            </button>
          </div>
        )}

        {/* Choose phase */}
        {(phase === 'choose' || phase === 'pulling' || phase === 'entering') && (
          <div className="grid gap-4 sm:grid-cols-2">
            {/* LOCAL MODE CARD */}
            <div className="group relative flex flex-col rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.035] p-5 transition-all duration-300 hover:border-emerald-400/40 hover:bg-emerald-400/[0.06]">
              <div className="mb-3 flex items-center gap-2">
                <Zap className="h-4 w-4 text-emerald-300" />
                <h2 className="text-sm font-black uppercase tracking-[0.18em] text-emerald-200">Local Mode</h2>
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[8.5px] font-bold tracking-wider text-emerald-300">DEFAULT</span>
                <span className="ml-auto rounded-full border border-emerald-400/30 px-2 py-0.5 font-mono text-[9px] font-bold tracking-wider text-emerald-300/90">FREE · OFFLINE</span>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-white/55">
                100% on-device AI. Zero cloud, zero cost, complete privacy. Powered by Ollama with an auto-selected model tuned to your GPU.
              </p>

              {/* Hardware audit */}
              {hardware ? (
                <div className="mb-4 space-y-1.5 rounded-xl border border-white/[0.06] bg-black/20 p-3 font-mono text-[10.5px] text-white/60">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-3 w-3 text-cyan-300/70" />
                    <span className="truncate" title={gpu?.name || 'No CUDA GPU detected'}>
                      {gpu ? `${gpu.name}` : 'No CUDA GPU detected'}
                    </span>
                    {gpu?.cudaSupported && (
                      <span className="ml-auto rounded bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">CUDA{gpu.cudaComputeCapability ? ` ${gpu.cudaComputeCapability}` : ''}</span>
                    )}
                  </div>
                  {gpu && (
                    <div className="flex items-center gap-2">
                      <HardDrive className="h-3 w-3 text-cyan-300/70" />
                      <span>VRAM {fmtMB(gpu.vramTotalMB)} · free {fmtMB(gpu.vramFreeMB)}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <MemoryStick className="h-3 w-3 text-cyan-300/70" />
                    <span>RAM {fmtMB(hardware.ram.totalMB)} · free {fmtMB(hardware.ram.freeMB)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Cpu className="h-3 w-3 text-cyan-300/70" />
                    <span className="truncate" title={hardware.cpu.model}>{hardware.cpu.logicalCores} threads — {hardware.cpu.model}</span>
                  </div>
                </div>
              ) : (
                <div className="mb-4 rounded-xl border border-white/[0.06] bg-black/20 p-3 font-mono text-[10.5px] text-white/40">
                  Hardware audit unavailable.
                </div>
              )}

              {/* Recommendation */}
              {recommendation && (
                <div className="mb-4 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.05] p-3">
                  <p className="mb-1 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-cyan-300/80">Recommended for your hardware</p>
                  <button
                    type="button"
                    onClick={() => setSelectedModel(recommendation.model)}
                    className={`w-full rounded-lg border p-2 text-left transition ${selectedModel === recommendation.model ? 'border-cyan-300/50 bg-cyan-300/10' : 'border-transparent hover:bg-white/5'}`}
                  >
                    <span className="flex items-center gap-2 text-xs font-bold text-white">
                      {selectedModel === recommendation.model && <CheckCircle2 className="h-3.5 w-3.5 text-cyan-300" />}
                      {recommendation.spec.label}
                    </span>
                    <span className="mt-1 block font-mono text-[9.5px] text-white/45">
                      ~{fmtMB(recommendation.spec.downloadMB)} download · {Math.round(recommendation.spec.contextWindow / 1024)}K ctx · {recommendation.spec.speedClass}
                    </span>
                  </button>
                  {recommendation.alternative && (
                    <button
                      type="button"
                      onClick={() => setSelectedModel(recommendation.alternative!.model)}
                      className={`mt-1.5 w-full rounded-lg border p-2 text-left transition ${selectedModel === recommendation.alternative.model ? 'border-cyan-300/50 bg-cyan-300/10' : 'border-transparent hover:bg-white/5'}`}
                    >
                      <span className="flex items-center gap-2 text-[11px] font-semibold text-white/80">
                        {selectedModel === recommendation.alternative.model && <CheckCircle2 className="h-3.5 w-3.5 text-cyan-300" />}
                        {recommendation.alternative.label} <span className="text-white/35">— faster option</span>
                      </span>
                    </button>
                  )}
                  <p className="mt-2 text-[10px] leading-relaxed text-white/40">{recommendation.rationale}</p>
                </div>
              )}

              {/* Ollama readiness + guided setup (local-first: if the local
                  engine isn't ready, walk the user through fixing it AND offer
                  the online escape hatch — exactly two options, no dead end). */}
              {status && !status.ollama.running && (
                <div className="mb-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] text-amber-100/80">
                  <p className="flex items-center gap-1.5 font-bold">
                    <AlertTriangle className="h-3 w-3" />
                    {status.ollama.installed ? 'Ollama is installed but not running' : 'Ollama is not installed — 2-minute local setup'}
                  </p>

                  {!status.ollama.installed ? (
                    <ol className="mt-2 list-inside list-decimal space-y-1.5 text-amber-100/60">
                      <li>
                        Download the installer from{' '}
                        <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="font-bold text-amber-200 underline decoration-amber-400/40 hover:decoration-amber-200">
                          ollama.com/download
                        </a>{' '}(Windows / macOS / Linux).
                      </li>
                      <li>
                        Run <span className="font-mono text-[10px] text-amber-200/90">OllamaSetup.exe</span> — it installs and starts a background service automatically.
                      </li>
                      <li>Click <span className="font-bold text-amber-200">Check again</span> below — SERA will detect it and offer a 1-click model download.</li>
                    </ol>
                  ) : (
                    <ol className="mt-2 list-inside list-decimal space-y-1.5 text-amber-100/60">
                      <li>Open <span className="font-bold text-amber-200">Start Menu → Ollama</span> (Windows keeps it running in the system tray).</li>
                      <li>Or run <span className="font-mono text-[10px] text-amber-200/90">ollama serve</span> in a terminal.</li>
                      <li>Click <span className="font-bold text-amber-200">Check again</span> — SERA reconnects automatically.</li>
                    </ol>
                  )}

                  {status.ollama.probeNotes?.map((note, i) => (
                    <p key={i} className="mt-1 font-mono text-[10px] text-amber-100/40">• {note}</p>
                  ))}

                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void recheck()}
                      disabled={rechecking || phase === 'auditing'}
                      className="flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-[10px] font-bold text-amber-100 transition hover:bg-amber-400/20 disabled:opacity-40"
                    >
                      {rechecking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
                      {rechecking ? 'Checking…' : 'Check again'}
                    </button>
                    <button
                      type="button"
                      onClick={() => enterMode('online')}
                      disabled={phase === 'entering'}
                      className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-bold text-white/70 transition hover:bg-white/10 disabled:opacity-40"
                    >
                      <Cloud className="h-3 w-3" />
                      Use Online Mode instead
                    </button>
                  </div>
                </div>
              )}

              {pull.view.active || pull.phase !== 'idle' ? (
                <div className="mb-4">
                  <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] text-white/60">
                    <span>
                      {pull.phase === 'error'
                        ? pull.error?.what ?? 'Download failed'
                        : pull.phase === 'ready'
                          ? 'Model ready — verified with Ollama'
                          : phaseLabel(pull.phase)}
                    </span>
                    <span>{pull.phase === 'ready' ? '100%' : `${Math.round(pull.view.fraction * 100)}%`}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${pull.phase === 'error' ? 'bg-rose-400' : 'bg-gradient-to-r from-emerald-400 to-cyan-400'}`}
                      style={{ width: `${Math.max(3, Math.round(pull.view.fraction * 100))}%` }}
                    />
                  </div>
                  <p className="mt-1.5 truncate font-mono text-[9.5px] text-white/40">{pull.view.label}</p>
                </div>
              ) : null}

              {pull.phase === 'error' && pull.error && (
                <div className="mb-3 rounded-lg border border-rose-400/20 bg-rose-400/[0.06] p-2.5 text-[10.5px] leading-relaxed text-rose-100/85">
                  <p className="font-bold text-rose-200">{pull.error.what}</p>
                  <p className="mt-1 text-rose-100/60">{pull.error.fix}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {pull.error.retryable && pull.model && (
                      <button
                        type="button"
                        onClick={() => void startPull(pull.model!)}
                        className="flex items-center gap-1 rounded-lg border border-rose-400/30 bg-rose-400/10 px-2.5 py-1 font-mono text-[9px] font-bold text-rose-100 transition hover:bg-rose-400/20"
                      >
                        <RotateCw className="h-3 w-3" /> RETRY DOWNLOAD
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => enterMode('online')}
                      disabled={phase === 'entering'}
                      className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[9px] font-bold text-white/70 transition hover:bg-white/10 disabled:opacity-40"
                    >
                      <Cloud className="h-3 w-3" /> USE ONLINE MODE
                    </button>
                  </div>
                </div>
              )}

              {/* Local actions */}
              <div className="mt-auto space-y-2">
                {status && !status.recommendedModelInstalled && status.ollama.installed && (
                  <button
                    type="button"
                    disabled={pull.view.active || !selectedModel}
                    onClick={() => selectedModel && void startPull(selectedModel)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400/15 py-2.5 text-xs font-bold text-emerald-200 transition hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {pull.view.active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                    {pull.view.active ? 'Downloading…' : '1-Click Download Model'}
                  </button>
                )}
                <button
                  type="button"
                  disabled={phase === 'entering'}
                  onClick={() => enterMode('local')}
                  className="group/btn flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-400/90 py-3 text-sm font-black text-emerald-950 shadow-lg transition hover:bg-emerald-300 disabled:opacity-50"
                >
                  {phase === 'entering' && enteredMode === 'local' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                  Enter Local Mode
                  <ChevronRight className="h-4 w-4 transition-transform group-hover/btn:translate-x-0.5" />
                </button>
                <p className="text-center font-mono text-[9px] uppercase tracking-wider text-white/30">Recommended · private & free · switches anytime</p>
              </div>
            </div>

            {/* ONLINE MODE CARD */}
            <div className="group relative flex flex-col rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.035] p-5 transition-all duration-300 hover:border-cyan-400/40 hover:bg-cyan-400/[0.06]">
              <div className="mb-3 flex items-center gap-2">
                <Cloud className="h-4 w-4 text-cyan-300" />
                <h2 className="text-sm font-black uppercase tracking-[0.18em] text-cyan-200">Online Mode</h2>
                <span className="ml-auto rounded-full border border-cyan-400/30 px-2 py-0.5 font-mono text-[9px] font-bold tracking-wider text-cyan-300/90">HIGH-SPEED</span>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-white/55">
                Real-time voice through Gemini Live ({'gemini-3.1-flash-live-preview'}) with sub-second latency. Add your own keys for Gemini, OpenAI or DeepSeek in Settings — encrypted at rest.
              </p>

              <div className="mb-4 space-y-2 rounded-xl border border-white/[0.06] bg-black/20 p-3 text-[11px] text-white/60">
                <p className="flex items-center gap-2"><Wifi className="h-3 w-3 text-cyan-300/70" /> Continuous real-time voice + instant barge-in</p>
                <p className="flex items-center gap-2"><ShieldCheck className="h-3 w-3 text-cyan-300/70" /> API keys stored AES-256-GCM encrypted, never in plain text</p>
                <p className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3 text-cyan-300/70" /> Full 36-tool computer-control suite included</p>
                {status && !status.ollama.running && (
                  <p className="flex items-center gap-2 text-emerald-300/80"><CheckCircle2 className="h-3 w-3" /> Great fit right now — zero local setup needed</p>
                )}
                {!status && <p className="flex items-center gap-2 text-white/35"><AlertTriangle className="h-3 w-3" /> Needs a Gemini API key (set in .env or Settings)</p>}
                {hasServerKey !== null && (
                  <p className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${hasServerKey ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                    {hasServerKey ? 'Server Gemini key detected — ready to go' : 'No server key yet — add one in Settings → API Keys'}
                  </p>
                )}
              </div>

              <div className="mt-auto">
                <button
                  type="button"
                  disabled={phase === 'entering'}
                  onClick={() => enterMode('online')}
                  className="group/btn flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/90 py-3 text-sm font-black text-cyan-950 shadow-lg transition hover:bg-cyan-300 disabled:opacity-50"
                >
                  {phase === 'entering' && enteredMode === 'online' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
                  Enter Online Mode
                  <ChevronRight className="h-4 w-4 transition-transform group-hover/btn:translate-x-0.5" />
                </button>
                <p className="mt-2 text-center font-mono text-[9px] uppercase tracking-wider text-white/30">Cloud APIs · switches anytime</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
