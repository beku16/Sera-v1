import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Check, Cpu, Download, HardDrive, MemoryStick, Mic, Monitor, RefreshCw, Wand2, Zap } from 'lucide-react';
import type { AssistantSettings } from '../../types';
import { formatBytes, type PullView } from '../../local/pullClient';
import { runVerifiedPull, IDLE_VERIFIED_PULL, type VerifiedPullState } from '../../local/modelPullClient';

/**
 * MY PC & MODEL — the permanent home of the hardware audit and the local
 * model recommendation. The startup wizard shows this once; this tab keeps
 * it reachable any time, answering "which model should I use according to
 * my device and specs?" without re-running the wizard.
 *
 * v1.6.7: honest pulls + full catalog picker.
 *  - A pull only says "installed" after Ollama's own /api/tags confirms the
 *    model exists (this kills the ghost "installed" with zero models bug).
 *  - Pull errors from Ollama are surfaced verbatim — never swallowed.
 *  - Live progress bar with downloaded / total bytes on EVERY install.
 *  - New CHOOSE YOUR OWN MODEL section: the whole catalog, one INSTALL/USE
 *    row per model, each with its own progress bar.
 *
 * Data comes from the same endpoints the wizard uses:
 *   GET  /api/local/status  → hardware audit + recommendation + installed
 *                             models + Ollama state + speech engines
 *   GET  /api/local/catalog → every known local model + VRAM budget
 *   POST /api/local/pull    → NDJSON download progress for a new model
 */

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

interface CatalogSpec {
  id: string;
  label: string;
  estVramMB: number;
  downloadMB: number;
  contextWindow: number;
  speedClass: 'lightning' | 'fast' | 'balanced';
  strengths: string;
  /** v1.9.0: honest per-model fit grading from /api/local/catalog. */
  fit?: { category: 'excellent' | 'good' | 'usable' | 'cpu-fallback' | 'not-recommended'; label: string; headroomMB: number };
  provider?: string;
  params?: string;
  vision?: boolean;
  toolSupport?: 'native' | 'basic' | 'limited';
  notes?: string;
  cpuFallback?: boolean;
}

interface CatalogResponse {
  tier: HardwareReport['tier'];
  vramAvailableMB: number;
  recommended: string;
  catalog: CatalogSpec[];
}

interface MyPcTabProps {
  settings: AssistantSettings;
  onUpdateSettings: (partial: Partial<AssistantSettings>) => void;
  /** v1.8.4: reopens the startup wizard (offline/online mode choice + guided local setup). */
  onOpenSetupWizard?: () => void;
  /** Opens the secure uninstallation wizard modal */
  onOpenUninstall?: () => void;
}

const IDLE_PULL_STATE: VerifiedPullState = IDLE_VERIFIED_PULL;

const fmtMB = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

const TIER_LABEL: Record<HardwareReport['tier'], string> = {
  'cuda-high': 'GPU STRONG',
  'cuda-mid': 'GPU MID',
  'cuda-low': 'GPU LIGHT',
  'cpu-only': 'CPU ONLY',
};

const SPEED_LABEL: Record<CatalogSpec['speedClass'], string> = {
  lightning: 'lightning',
  fast: 'fast',
  balanced: 'balanced',
};

const FIT_BADGE: Record<NonNullable<CatalogSpec['fit']>['category'], { text: string; className: string }> = {
  excellent: { text: 'EXCELLENT FIT', className: 'bg-emerald-500/15 text-emerald-500' },
  good: { text: 'GOOD FIT', className: 'bg-emerald-500/10 text-emerald-500/90' },
  usable: { text: 'PARTIAL OFFLOAD', className: 'bg-amber-500/15 text-amber-500' },
  'cpu-fallback': { text: 'CPU FALLBACK', className: 'bg-amber-500/10 text-amber-500/90' },
  'not-recommended': { text: 'NOT RECOMMENDED', className: 'bg-red-500/15 text-red-400' },
};

function isModelInstalledLocal(model: string, installed: Array<{ name: string }>): boolean {
  if (!model) return false;
  const target = model.toLowerCase();
  const family = (model.split(':')[0] || '').toLowerCase();
  if (!family) return false;
  return installed.some((m) => {
    const name = (m.name || '').toLowerCase();
    if (!name) return false;
    if (name === target) return true;
    return name.split(':')[0] === family;
  });
}

export const MyPcTab: React.FC<MyPcTabProps> = ({ settings, onUpdateSettings, onOpenSetupWizard, onOpenUninstall }) => {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [auditing, setAuditing] = useState(true);
  const [pull, setPull] = useState(IDLE_PULL_STATE);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [startingOllama, setStartingOllama] = useState<string | null>(null);
  const pullAbort = useRef<AbortController | null>(null);

  const runAudit = useCallback(async (opts: { rescan?: boolean } = {}) => {
    setAuditing(true);
    try {
      const [statusRes, catalogRes] = await Promise.all([
        fetch(`/api/local/status${opts.rescan ? '?rescan=1' : ''}`),
        fetch(`/api/local/catalog${opts.rescan ? '?rescan=1' : ''}`).catch(() => null),
      ]);
      setStatus(statusRes.ok ? ((await statusRes.json()) as LocalStatus) : null);
      if (catalogRes && catalogRes.ok) setCatalog((await catalogRes.json()) as CatalogResponse);
    } catch {
      setStatus(null);
    } finally {
      setAuditing(false);
    }
  }, []);

  useEffect(() => {
    void runAudit();
    return () => pullAbort.current?.abort();
  }, [runAudit]);

  /** v1.9.0 (spec §11/§12 — State B): one click starts the installed-but-
   * stopped Ollama service through the server's owned-process manager. */
  const startOllama = useCallback(async () => {
    if (startingOllama) return;
    setStartingOllama('Starting the Ollama service (up to 30 s)…');
    try {
      const res = await fetch('/api/local/ollama/start', { method: 'POST' });
      const report = res.ok ? await res.json() : null;
      setStartingOllama(report?.message || null);
      await runAudit({ rescan: true });
    } catch {
      setStartingOllama('Could not start Ollama. Open it from the Start Menu or run "ollama serve" in a terminal.');
    }
  }, [startingOllama, runAudit]);

  /** v1.9.0: support workflows — open the rotating log folder. */
  const openLogFolder = useCallback(async () => {
    const desktop = (window as unknown as { seraDesktop?: { openLogFolder?: () => Promise<unknown> } }).seraDesktop;
    if (desktop?.openLogFolder) {
      await desktop.openLogFolder();
      return;
    }
    try {
      const res = await fetch('/api/diagnostics/log-folder');
      const data = res.ok ? await res.json() : null;
      setStartingOllama(data?.dir ? `Logs live at: ${data.dir}` : 'Log folder unavailable.');
    } catch {
      setStartingOllama('Log folder unavailable.');
    }
  }, []);

  /**
   * THE pull flow (v1.9.0): now the SHARED runVerifiedPull used by the
   * startup wizard too — stream → verify with Ollama's own model list →
   * only then "installed", with structured WHAT/WHY/FIX failures.
   */
  const startPull = async (model: string) => {
    if (pull.model && pull.view.active) return;
    pullAbort.current = new AbortController();
    setPull({ ...IDLE_VERIFIED_PULL, model, phase: 'preparing' });
    try {
      const finalState = await runVerifiedPull(model, {
        signal: pullAbort.current.signal,
        onUpdate: (s) => setPull((prev) => (prev.model === model || prev.model === null ? s : prev)),
      });
      // Pull a fresh audit either way (installed list / recommendation).
      void runAudit();
      if (finalState.phase === 'error' && finalState.error) {
        console.warn(`[MY-PC] Pull failed honestly: ${finalState.error.what} — ${finalState.error.why}`);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPull(IDLE_PULL_STATE);
        return;
      }
      throw err;
    }
  };

  // v1.6.9 FIX: this used to fall back to `status?.recommendation.model`,
  // which stamped the phantom "ACTIVE" badge on the RECOMMENDED card while
  // MODELS ON THIS PC said "No models installed yet" (user's screenshot —
  // recommendation "ACTIVE", pull FAILED, nothing installed). ACTIVE must
  // mean "the user actually selected this model", nothing else.
  const activeModel = settings.localModel || '';
  const installed = status?.installedModels || [];
  const recommendation = status?.recommendation;
  const hardware = status?.hardware;
  const isPulling = (m: string) => pull.model === m && pull.view.active;
  const rowInstalled = (m: string) => isModelInstalledLocal(m, installed);

  return (
    <div className="space-y-5 animate-fade-up">

      {/* ── Hardware audit ─────────────────────────────────── */}
      <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
            <Monitor className="h-4 w-4 text-cyan-500" /> YOUR HARDWARE
          </span>
          <button
            type="button"
            onClick={() => void runAudit({ rescan: true })}
            className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2 py-1 font-mono text-[9px] text-graphite hover:text-ink"
            title="Force a fresh hardware probe (skips the 5-minute cache): GPU, VRAM, RAM, CPU"
          >
            <RefreshCw className={`h-3 w-3 ${auditing ? 'animate-spin' : ''}`} /> RE-SCAN HARDWARE
          </button>
        </div>

        {auditing && !hardware ? (
          <p className="font-mono text-[10px] text-graphite">Auditing your device — GPU, RAM, CPU…</p>
        ) : !hardware ? (
          <p className="font-mono text-[10px] text-graphite">Hardware audit unavailable — is the SERA server running?</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-line bg-panel p-2.5">
                <div className="flex items-center gap-1.5 font-mono text-[9px] text-graphite"><Cpu className="h-3 w-3" /> CPU</div>
                <div className="mt-1 truncate font-sans text-[11px] font-bold text-ink" title={hardware.cpu.model}>{hardware.cpu.model || 'Unknown'}</div>
                <div className="font-mono text-[9px] text-graphite">{hardware.cpu.logicalCores} logical cores</div>
              </div>
              <div className="rounded-xl border border-line bg-panel p-2.5">
                <div className="flex items-center gap-1.5 font-mono text-[9px] text-graphite"><MemoryStick className="h-3 w-3" /> MEMORY</div>
                <div className="mt-1 font-sans text-[11px] font-bold text-ink">{fmtMB(hardware.ram.totalMB)}</div>
                <div className="font-mono text-[9px] text-graphite">{fmtMB(hardware.ram.freeMB)} free</div>
              </div>
              <div className="col-span-2 rounded-xl border border-line bg-panel p-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-mono text-[9px] text-graphite"><Zap className="h-3 w-3" /> GRAPHICS</div>
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[8px] font-bold tracking-wider ${hardware.tier === 'cuda-high' || hardware.tier === 'cuda-mid' ? 'bg-emerald-500/15 text-emerald-500' : hardware.tier === 'cuda-low' ? 'bg-amber-500/15 text-amber-500' : 'bg-white/10 text-graphite'}`}>
                    {TIER_LABEL[hardware.tier]}
                  </span>
                </div>
                <div className="mt-1 truncate font-sans text-[11px] font-bold text-ink" title={hardware.gpu?.name || ''}>
                  {hardware.gpu ? hardware.gpu.name : 'No dedicated GPU detected'}
                </div>
                <div className="font-mono text-[9px] text-graphite">
                  {hardware.gpu ? `${fmtMB(hardware.gpu.vramTotalMB)} VRAM (${fmtMB(hardware.gpu.vramFreeMB)} free)${hardware.gpu.cudaSupported ? ' · CUDA' : ''}` : 'SERA will run models on CPU'}
                </div>
              </div>
            </div>

            {/* Model fit budget */}
            {recommendation && (
              <p className="font-mono text-[9px] leading-relaxed text-graphite/80">
                Model budget: {recommendation.budget.fitsInVram
                  ? `the recommended model fits fully in your ${fmtMB(recommendation.budget.vramAvailableMB)} of VRAM (${fmtMB(recommendation.budget.vramRequiredMB)} needed).`
                  : `your VRAM is tight — the model will partly run on CPU${recommendation.budget.cpuFallback ? ' (supported)' : ''}.`}
              </p>
            )}
          </>
        )}
      </div>

      {/* ── Recommended model ──────────────────────────────── */}
      <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
        <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
          <Activity className="h-4 w-4 text-emerald-500" /> RECOMMENDED FOR YOUR HARDWARE
        </span>

        {recommendation ? (
          <>
            <div className={`rounded-xl border p-3 ${activeModel === recommendation.model ? 'border-emerald-500/60 bg-emerald-500/5 ring-1 ring-emerald-500/40' : 'border-line bg-panel'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-xs font-bold text-ink">{recommendation.model}</span>
                    {rowInstalled(recommendation.model) && (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[8px] font-bold tracking-wider text-emerald-500">INSTALLED</span>
                    )}
                    {activeModel === recommendation.model && (
                      <span className="rounded-full bg-cyan-500/15 px-2 py-0.5 font-mono text-[8px] font-bold tracking-wider text-cyan-500">ACTIVE</span>
                    )}
                  </div>
                  <p className="mt-1 font-sans text-[11px] font-semibold text-ink">{recommendation.spec.label}</p>
                  <p className="mt-1 font-mono text-[9px] leading-relaxed text-graphite">{recommendation.rationale}</p>
                  <p className="mt-1 font-mono text-[9px] text-graphite/70">
                    {fmtMB(recommendation.spec.downloadMB)} download · {recommendation.spec.contextWindow.toLocaleString()} context · {recommendation.spec.speedClass}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {!rowInstalled(recommendation.model) && (
                    <button
                      type="button"
                      onClick={() => void startPull(recommendation.model)}
                      disabled={Boolean(pull.model && pull.view.active)}
                      className="inline-flex items-center gap-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-[9px] font-bold text-ink hover:bg-white/10 disabled:opacity-50"
                    >
                      <Download className="h-3 w-3" /> {isPulling(recommendation.model) ? 'DOWNLOADING…' : 'INSTALL'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ localModel: recommendation.model })}
                    disabled={activeModel === recommendation.model}
                    className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 font-mono text-[9px] font-bold text-ink hover:bg-white/10 disabled:opacity-40"
                  >
                    <Check className="h-3 w-3" /> USE THIS
                  </button>
                </div>
              </div>
            </div>

            {recommendation.alternative && (
              <div className="rounded-xl border border-line bg-panel p-3">
                <p className="font-mono text-[9px] leading-relaxed text-graphite">
                  <span className="font-bold text-ink">Lighter option — {recommendation.alternative.model}:</span>{' '}
                  {recommendation.alternative.rationale}
                </p>
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => onUpdateSettings({ localModel: recommendation.alternative!.model })}
                    disabled={activeModel === recommendation.alternative.model}
                    className="rounded-lg border border-line bg-paper px-2.5 py-1 font-mono text-[9px] font-bold text-graphite hover:text-ink disabled:opacity-40"
                  >
                    USE {recommendation.alternative.model.split(':')[0].toUpperCase()}
                  </button>
                  {!rowInstalled(recommendation.alternative.model) && (
                    <button
                      type="button"
                      onClick={() => void startPull(recommendation.alternative!.model)}
                      disabled={Boolean(pull.model && pull.view.active)}
                      className="inline-flex items-center gap-1 rounded-lg border border-line bg-paper px-2.5 py-1 font-mono text-[9px] font-bold text-graphite hover:text-ink disabled:opacity-50"
                    >
                      <Download className="h-3 w-3" /> {isPulling(recommendation.alternative.model) ? 'DOWNLOADING…' : 'INSTALL'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="font-mono text-[10px] text-graphite">Recommendation pending — run the audit above.</p>
        )}

        <PullProgressCard pull={pull} />
      </div>

      {/* ── Installed models ───────────────────────────────── */}
      <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
        <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
          <HardDrive className="h-4 w-4 text-amber-500" /> MODELS ON THIS PC
        </span>
        {installed.length === 0 ? (
          <p className="font-mono text-[10px] leading-relaxed text-graphite">
            No models installed yet — install the recommended one above, or scroll down and pick your own from the full catalog.
          </p>
        ) : (
          <div className="space-y-1.5">
            {installed.map((m) => (
              <button
                key={m.name}
                type="button"
                onClick={() => onUpdateSettings({ localModel: m.name })}
                className={`flex w-full items-center justify-between rounded-xl border p-2.5 text-left transition ${
                  activeModel === m.name ? 'border-line-strong bg-panel ring-1 ring-ink' : 'border-line bg-panel/60 hover:bg-panel'
                }`}
              >
                <div className="min-w-0">
                  <span className="block truncate font-mono text-[11px] font-bold text-ink">{m.name}</span>
                  <span className="font-mono text-[9px] text-graphite">{formatBytes(m.sizeBytes)}</span>
                </div>
                {activeModel === m.name ? (
                  <span className="shrink-0 font-mono text-[9px] font-bold tracking-wider text-emerald-500">ACTIVE</span>
                ) : (
                  <span className="shrink-0 font-mono text-[9px] font-bold tracking-wider text-graphite">USE</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── Choose your own — the full catalog ─────────────── */}
      <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
            <Download className="h-4 w-4 text-violet-500" /> CHOOSE YOUR OWN MODEL
          </span>
          <span className="font-mono text-[8px] tracking-wider text-graphite/70">EVERY MODEL SERA CAN RUN LOCALLY</span>
        </div>
        {!catalog ? (
          <p className="font-mono text-[10px] text-graphite">Loading the model catalog…</p>
        ) : (
          <div className="space-y-2">
            {catalog.catalog.map((spec) => {
              const installedHere = rowInstalled(spec.id);
              const isActive = activeModel === spec.id;
              const fits = catalog.vramAvailableMB >= spec.estVramMB;
              const pulling = isPulling(spec.id);
              return (
                <div
                  key={spec.id}
                  className={`rounded-xl border p-3 ${isActive ? 'border-cyan-500/60 bg-cyan-500/5 ring-1 ring-cyan-500/40' : installedHere ? 'border-emerald-500/40 bg-panel' : 'border-line bg-panel/60'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-mono text-[11px] font-bold text-ink">{spec.label}</span>
                        {catalog.recommended === spec.id && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-emerald-500">RECOMMENDED</span>
                        )}
                        {spec.fit && (
                          <span className={`rounded-full px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider ${FIT_BADGE[spec.fit.category].className}`}>
                            {FIT_BADGE[spec.fit.category].text}
                          </span>
                        )}
                        {spec.vision && (
                          <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-violet-400">VISION</span>
                        )}
                        {spec.toolSupport === 'native' && (
                          <span className="rounded-full bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-cyan-500">TOOLS</span>
                        )}
                        {installedHere && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-emerald-500">INSTALLED</span>
                        )}
                        {isActive && (
                          <span className="rounded-full bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[8px] font-bold tracking-wider text-cyan-500">ACTIVE</span>
                        )}
                      </div>
                      <p className="mt-1 font-mono text-[9px] text-graphite">{spec.id}</p>
                      <p className="mt-1 font-mono text-[9px] leading-relaxed text-graphite/80">{spec.strengths}</p>
                      {spec.notes && <p className="mt-0.5 font-mono text-[8.5px] leading-relaxed text-graphite/60">{spec.notes}</p>}
                      <p className="mt-1 font-mono text-[9px] text-graphite/70">
                        {fmtMB(spec.downloadMB)} download · {spec.contextWindow.toLocaleString()} context · {SPEED_LABEL[spec.speedClass]} ·{' '}
                        <span className={fits ? 'text-emerald-500' : 'text-amber-500'}>
                          {fits ? 'fits your VRAM' : `needs ${fmtMB(spec.estVramMB)} VRAM — will run${spec.cpuFallback ? ' slower on CPU' : ' ONLY on a bigger GPU'}`}
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      {installedHere ? (
                        <button
                          type="button"
                          onClick={() => onUpdateSettings({ localModel: spec.id })}
                          disabled={isActive}
                          className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-paper px-2.5 py-1.5 font-mono text-[9px] font-bold text-ink hover:bg-white/10 disabled:opacity-40"
                        >
                          <Check className="h-3 w-3" /> {isActive ? 'IN USE' : 'USE'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void startPull(spec.id)}
                          disabled={Boolean(pull.model && pull.view.active)}
                          className="inline-flex items-center gap-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[9px] font-bold text-ink hover:bg-white/10 disabled:opacity-50"
                        >
                          <Download className="h-3 w-3" /> {pulling ? 'DOWNLOADING…' : 'INSTALL'}
                        </button>
                      )}
                    </div>
                  </div>
                  {pulling && pull.model === spec.id && <PullProgressBar view={pull.view} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Ollama + offline speech status ─────────────────── */}
      <div className="space-y-3 rounded-2xl border border-line bg-paper p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2 font-mono text-xs font-bold tracking-[0.14em] text-ink">
            <Mic className="h-4 w-4 text-cyan-500" /> LOCAL ENGINE STATUS
          </span>
          {/* v1.8.4: the startup wizard (offline/online choice + guided
              Ollama setup) used to be reachable ONLY on first launch —
              this button makes its instructions available any time. */}
          {onOpenSetupWizard && (
            <button
              type="button"
              onClick={onOpenSetupWizard}
              className="flex items-center gap-1 rounded-lg border border-line bg-panel px-2 py-1 font-mono text-[9px] text-graphite hover:text-ink"
              title="Reopen the startup wizard: choose Local (offline) or Online mode and follow the guided Ollama setup instructions"
            >
              <Wand2 className="h-3 w-3" /> SETUP WIZARD
            </button>
          )}
        </div>
        {!status ? (
          <p className="font-mono text-[10px] text-graphite">Status unavailable — is the SERA server running?</p>
        ) : (
          <>
            <div className="flex items-center justify-between rounded-xl border border-line bg-panel p-3">
              <div>
                <span className="block font-sans text-xs font-bold text-ink">Ollama (the local brain)</span>
                <span className="block font-mono text-[9px] text-graphite">
                  {status.ollama.running
                    ? `Running ${status.ollama.version ? `· v${status.ollama.version}` : ''}`
                    : status.ollama.installHint || 'Not running — start Ollama, then re-audit'}
                </span>
                {startingOllama && (
                  <span className="mt-1 block font-mono text-[9px] leading-relaxed text-cyan-600">{startingOllama}</span>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <span className={`rounded-full px-2 py-0.5 font-mono text-[8px] font-bold tracking-wider ${status.ollama.running ? 'bg-emerald-500/15 text-emerald-500' : 'bg-red-500/15 text-red-400'}`}>
                  {status.ollama.running ? 'ONLINE' : 'DOWN'}
                </span>
                {!status.ollama.running && status.ollama.installed && (
                  <button
                    type="button"
                    onClick={() => void startOllama()}
                    disabled={Boolean(startingOllama && startingOllama.startsWith('Starting'))}
                    className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-[9px] font-bold text-emerald-600 transition hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    START OLLAMA
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-line bg-panel p-3">
              <div>
                <span className="block font-sans text-xs font-bold text-ink">Offline voice recognition (whisper)</span>
                <span className="block font-mono text-[9px] leading-relaxed text-graphite">
                  {status.speech.stt.available
                    ? 'Installed — your microphone transcribes 100% offline in Local Mode'
                    : status.speech.stt.hint || 'Not installed — Local Mode falls back to Windows speech'}
                </span>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[8px] font-bold tracking-wider ${status.speech.stt.available ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}`}>
                {status.speech.stt.available ? 'READY' : 'MISSING'}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-xl border border-line bg-panel p-3">
              <div>
                <span className="block font-sans text-xs font-bold text-ink">Offline voice (Sera speaking)</span>
                <span className="block font-mono text-[9px] leading-relaxed text-graphite">
                  {status.speech.tts.available ? 'Piper installed' : status.speech.tts.hint || 'Not installed — using built-in system voices'}
                </span>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[8px] font-bold tracking-wider ${status.speech.tts.available ? 'bg-emerald-500/15 text-emerald-500' : 'bg-white/10 text-graphite'}`}>
                {status.speech.tts.available ? 'READY' : 'FALLBACK'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel p-3">
              <div className="min-w-0">
                <span className="block font-sans text-xs font-bold text-ink">Troubleshooting logs</span>
                <span className="block font-mono text-[9px] leading-relaxed text-graphite">
                  Rotating, secret-redacted logs of every boot, model pull and crash — the first thing support asks for.
                </span>
              </div>
              <button
                type="button"
                onClick={() => void openLogFolder()}
                className="shrink-0 rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[9px] font-bold text-graphite transition hover:text-ink"
              >
                OPEN LOG FOLDER
              </button>
            </div>

            {/* ── UNINSTALL & DATA MANAGEMENT DANGER ZONE ── */}
            <div className="flex items-center justify-between gap-2 rounded-xl border border-red-500/30 bg-red-500/[0.04] p-3">
              <div className="min-w-0">
                <span className="block font-sans text-xs font-bold text-red-300">Uninstall SERA & Data Management</span>
                <span className="block font-mono text-[9px] leading-relaxed text-graphite">
                  Launch the secure uninstallation wizard with options to preserve your memories for future reinstall or perform a 100% clean wipe.
                </span>
              </div>
              <button
                type="button"
                onClick={onOpenUninstall}
                className="shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 font-mono text-[9px] font-bold text-red-300 transition hover:bg-red-500/20 active:scale-95"
              >
                UNINSTALL SERA
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/** Discord-style live download bar with real byte counters + honest verdicts. */
const PullProgressCard: React.FC<{ pull: VerifiedPullState }> = ({ pull }) => {
  if (!pull.model) return null;
  const { view, verified, model, error, phase } = pull;
  if (!view.active && phase === 'idle' && !view.error && !view.done) return null;

  const failed = Boolean(error) || verified === 'missing';
  return (
    <div className={`rounded-xl border p-3 ${failed ? 'border-red-500/50 bg-red-500/5' : phase === 'ready' ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-line bg-panel'}`}>
      <div className="flex items-center justify-between font-mono text-[9px] text-graphite">
        <span className="truncate">
          {error
            ? `${error.what} — NOT installed`
            : verified === 'missing'
              ? `${model} did NOT install — Ollama does not list it. Check disk space and the error above, then try again.`
              : phase === 'ready'
                ? `${model} installed — verified with Ollama`
                : view.label || 'Downloading…'}
        </span>
        <span className={`ml-2 shrink-0 font-bold ${view.active ? 'text-ink' : phase === 'ready' && !failed ? 'text-emerald-500' : 'text-red-400'}`}>
          {view.active ? `${Math.round(view.fraction * 100)}%` : phase === 'ready' && !failed ? 'DONE' : 'FAILED'}
        </span>
      </div>
      {error?.why ? (
        <p className="mt-1 break-words font-mono text-[8.5px] leading-relaxed text-red-300/70">{error.why}</p>
      ) : null}
      {error?.fix ? (
        <p className="mt-1 font-mono text-[8.5px] leading-relaxed text-graphite">{error.fix}</p>
      ) : null}
      {view.active && view.totalBytes ? (
        <div className="mt-0.5 font-mono text-[8px] text-graphite/70">
          {formatBytes(view.completedBytes || 0)} / {formatBytes(view.totalBytes)}
        </div>
      ) : null}
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-paper">
        <div
          className={`h-full rounded-full transition-all duration-200 ${failed ? 'bg-red-500' : phase === 'ready' ? 'bg-emerald-500' : 'bg-cyan-500'}`}
          style={{ width: `${failed ? 100 : Math.max(3, view.fraction * 100)}%` }}
        />
      </div>
    </div>
  );
};

/** Inline per-model bar used inside the catalog rows. */
const PullProgressBar: React.FC<{ view: PullView }> = ({ view }) => (
  <div className="mt-2">
    <div className="flex items-center justify-between font-mono text-[8px] text-graphite/80">
      <span className="truncate">{view.label || 'Downloading…'}</span>
      <span className="ml-2 shrink-0 font-bold text-ink">
        {view.active ? `${Math.round(view.fraction * 100)}%` : ''}
        {view.active && view.totalBytes ? ` · ${formatBytes(view.completedBytes || 0)} / ${formatBytes(view.totalBytes)}` : ''}
      </span>
    </div>
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-paper">
      <div className="h-full rounded-full bg-cyan-500 transition-all duration-200" style={{ width: `${Math.max(3, view.fraction * 100)}%` }} />
    </div>
  </div>
);
