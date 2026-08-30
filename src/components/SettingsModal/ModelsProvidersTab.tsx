import React, { useState, useEffect, useCallback } from 'react';
import { Boxes, Check, Loader2, AlertTriangle, ShieldCheck, ShieldAlert, Activity, HelpCircle, ChevronUp, ChevronDown, PlugZap } from 'lucide-react';

/**
 * Models & Providers — the Model & Providers Settings interface
 * (orchestration spec: USER CONTROL + "WHY DID YOU CHOOSE THIS MODEL?").
 *
 * Shows every provider/brain the orchestrator can use, its tier, health,
 * latency and capabilities. Lets the user pick the routing mode, enable or
 * disable providers, reorder priority, mark a cloud provider trusted for
 * private tasks, and — behind two explicit confirmations — unlock paid
 * providers. Paid stays OFF by default; SERA never spends money silently.
 */

type ProviderType = 'local' | 'free' | 'paid';
type RoutingMode = 'free_first' | 'local_first' | 'balanced' | 'performance_first' | 'custom';

interface ModelInfo {
  id: string;
  label: string;
  contextWindow: number;
  supportsVision: boolean;
  supportsTools: boolean;
  caps: Record<string, number>;
}

interface ProviderInfo {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  priority: number;
  freeTier: 'vendor_documented' | 'user_confirmed' | 'unverified';
  trustedForPrivate: boolean;
  hasKey: boolean;
  notes?: string;
  health: { state: string; avgLatencyMs: number; successRate: number; lastFailureKind?: string | null };
  models: ModelInfo[];
}

interface StatusPayload {
  routingMode: RoutingMode;
  providers: ProviderInfo[];
  cost: { allowPaidProviders: boolean; spentTodayUsd: number; spentThisMonthUsd: number; dailyBudgetUsd: number | null; monthlyBudgetUsd: number | null };
}

const ROUTING_MODES: Array<{ id: RoutingMode; label: string; hint: string }> = [
  { id: 'free_first', label: 'FREE-FIRST (recommended)', hint: 'Local first, then documented free tiers. Paid never unless unlocked.' },
  { id: 'local_first', label: 'LOCAL-FIRST', hint: 'Maximum privacy — cloud only when no local model can do the task.' },
  { id: 'balanced', label: 'BALANCED', hint: 'Weighs quality vs cost vs latency evenly.' },
  { id: 'performance_first', label: 'PERFORMANCE-FIRST', hint: 'Best capable model wins; cost matters less (paid still needs unlocking).' },
  { id: 'custom', label: 'CUSTOM', hint: 'Your per-provider priorities steer the router.' },
];

const TYPE_BADGE: Record<ProviderType, string> = {
  local: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
  free: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200',
  paid: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
};

const HEALTH_DOT: Record<string, string> = {
  healthy: 'bg-emerald-400',
  degraded: 'bg-amber-400',
  rate_limited: 'bg-orange-400',
  offline: 'bg-rose-500',
  invalid_key: 'bg-rose-400',
  unavailable: 'bg-rose-500',
  unknown: 'bg-zinc-500',
};

export const ModelsProvidersTab: React.FC = () => {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [sampleText, setSampleText] = useState('');
  const [explain, setExplain] = useState<string | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);
  const [paidConfirm, setPaidConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/orchestrator/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus((await res.json()) as StatusPayload);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(async (body: Record<string, unknown>, key: string) => {
    setBusy((p) => ({ ...p, [key]: true }));
    try {
      const res = await fetch('/api/orchestrator/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { status?: StatusPayload; rejected?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.status) setStatus(data.status);
      if (data.rejected && data.rejected.length > 0) {
        setTestResult((p) => ({ ...p, [key]: { ok: false, message: data.rejected!.join(' · ') } }));
      }
    } catch (err) {
      setTestResult((p) => ({ ...p, [key]: { ok: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setBusy((p) => ({ ...p, [key]: false }));
    }
  }, []);

  const testProvider = useCallback(async (id: string) => {
    setBusy((p) => ({ ...p, [`test:${id}`]: true }));
    try {
      const res = await fetch('/api/orchestrator/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: id }),
      });
      const data = (await res.json()) as { ok: boolean; message: string; latencyMs?: number; error?: string };
      setTestResult((p) => ({
        ...p,
        [`test:${id}`]: { ok: Boolean(data.ok), message: data.ok ? `${data.message}${data.latencyMs ? ` · ${data.latencyMs} ms` : ''}` : data.message || data.error || 'failed' },
      }));
      void load();
    } catch (err) {
      setTestResult((p) => ({ ...p, [`test:${id}`]: { ok: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setBusy((p) => ({ ...p, [`test:${id}`]: false }));
    }
  }, [load]);

  const explainRouting = useCallback(async () => {
    if (!sampleText.trim()) return;
    setExplainBusy(true);
    try {
      const res = await fetch('/api/orchestrator/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sampleText }),
      });
      const data = (await res.json()) as { explanation?: string; error?: string };
      setExplain(data.explanation || data.error || 'No explanation returned.');
    } catch (err) {
      setExplain(err instanceof Error ? err.message : String(err));
    } finally {
      setExplainBusy(false);
    }
  }, [sampleText]);

  if (loadError) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-3 font-mono text-[10px] text-rose-200">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Orchestrator unreachable: {loadError}
      </div>
    );
  }
  if (!status) {
    return <div className="flex items-center gap-2 p-4 font-mono text-[10px] text-graphite/60"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading model registry…</div>;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <span className="mb-1 flex items-center gap-1.5 font-mono text-[11px] tracking-[0.16em] text-graphite">
          <Boxes className="h-3.5 w-3.5" /> MODEL ORCHESTRATOR
        </span>
        <p className="font-mono text-[10px] leading-relaxed text-graphite/60">
          SERA picks the best AVAILABLE brain per task: local Ollama, documented free-tier APIs, or paid APIs (locked OFF by default).
        </p>
      </div>

      {/* Routing mode */}
      <div className="space-y-2">
        <span className="font-mono text-[10px] tracking-[0.14em] text-graphite/80">ROUTING MODE</span>
        <div className="grid gap-1.5">
          {ROUTING_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => void apply({ routingMode: m.id }, 'mode')}
              className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left transition ${status.routingMode === m.id ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-line bg-white/[0.02] hover:bg-white/[0.05]'}`}
            >
              <span>
                <span className="block font-mono text-[10px] tracking-wider text-zinc-100">{m.label}</span>
                <span className="block font-mono text-[9px] text-graphite/60">{m.hint}</span>
              </span>
              {status.routingMode === m.id && <Check className="h-3.5 w-3.5 text-emerald-300" />}
            </button>
          ))}
        </div>
      </div>

      {/* Paid kill switch */}
      <div className={`rounded-xl border p-3 ${status.cost.allowPaidProviders ? 'border-amber-400/40 bg-amber-400/[0.08]' : 'border-line bg-white/[0.02]'}`}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-zinc-100">
              {status.cost.allowPaidProviders ? <ShieldAlert className="h-3.5 w-3.5 text-amber-300" /> : <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />}
              ALLOW PAID PROVIDERS
            </span>
            <p className="mt-1 font-mono text-[9px] leading-relaxed text-graphite/60">
              {status.cost.allowPaidProviders
                ? 'Paid APIs may be called when no free/local option fits. Spend so far: $' + status.cost.spentThisMonthUsd.toFixed(4) + ' this month.'
                : 'Locked OFF — SERA will never spend money. Even enabled paid providers stay unreachable.'}
            </p>
          </div>
          {status.cost.allowPaidProviders ? (
            <button
              type="button"
              onClick={() => { setPaidConfirm(false); void apply({ allowPaidProviders: false }, 'paid'); }}
              className="shrink-0 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 font-mono text-[9px] tracking-wider text-emerald-200 hover:bg-emerald-400/20"
            >
              KEEP FREE ONLY
            </button>
          ) : paidConfirm ? (
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={() => { setPaidConfirm(false); void apply({ allowPaidProviders: true }, 'paid'); }}
                className="rounded-lg border border-amber-400/40 bg-amber-400/15 px-2.5 py-1.5 font-mono text-[9px] text-amber-100"
              >
                YES, UNLOCK
              </button>
              <button
                type="button"
                onClick={() => setPaidConfirm(false)}
                className="rounded-lg border border-line px-2.5 py-1.5 font-mono text-[9px] text-graphite"
              >
                CANCEL
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPaidConfirm(true)}
              className="shrink-0 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 font-mono text-[9px] tracking-wider text-amber-200 hover:bg-amber-400/20"
            >
              UNLOCK (2-STEP)
            </button>
          )}
        </div>
      </div>

      {/* Provider cards */}
      <div className="space-y-2">
        <span className="font-mono text-[10px] tracking-[0.14em] text-graphite/80">PROVIDERS ({status.providers.length})</span>
        {status.providers.map((p) => (
          <div key={p.id} className={`rounded-xl border p-3 ${p.enabled ? 'border-line bg-white/[0.03]' : 'border-line/50 bg-white/[0.01] opacity-75'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEALTH_DOT[p.health.state] ?? 'bg-zinc-500'}`} />
                  <span className="truncate font-mono text-[10px] font-medium text-zinc-100">{p.name}</span>
                  <span className={`rounded border px-1 py-px font-mono text-[8px] uppercase tracking-wider ${TYPE_BADGE[p.type]}`}>{p.type}</span>
                  {p.health.state !== 'healthy' && (
                    <span className="rounded border border-line px-1 py-px font-mono text-[8px] text-graphite/70">{p.health.state.replace('_', ' ')}</span>
                  )}
                  {p.health.avgLatencyMs > 0 && <span className="font-mono text-[8px] text-graphite/50">~{p.health.avgLatencyMs}ms</span>}
                  {!p.hasKey && p.type !== 'local' && <span className="font-mono text-[8px] text-amber-300/80">add key in API KEYS tab</span>}
                </span>
                {p.notes && <p className="mt-0.5 font-mono text-[9px] leading-relaxed text-graphite/50">{p.notes}</p>}
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  disabled={busy[`prov:${p.id}`]}
                  onChange={(e) => void apply({ providerId: p.id, enabled: e.target.checked }, `prov:${p.id}`)}
                  className="h-3.5 w-3.5 accent-emerald-400"
                />
                <span className="font-mono text-[9px] text-graphite/70">ON</span>
              </label>
            </div>

            {/* Models + capabilities */}
            <div className="mt-2 flex flex-wrap gap-1">
              {p.models.slice(0, 6).map((m) => (
                <span key={m.id} className="rounded-md border border-line/70 bg-black/20 px-1.5 py-0.5 font-mono text-[8px] text-graphite/80" title={`ctx ${m.contextWindow} · vision ${m.caps.vision}/10 · coding ${m.caps.coding}/10 · reasoning ${m.caps.reasoning}/10`}>
                  {m.id}{m.supportsVision ? ' ·👁' : ''}{m.supportsTools ? ' ·⚙' : ''}
                </span>
              ))}
            </div>

            {/* Controls */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  title="Higher priority (tried earlier)"
                  onClick={() => void apply({ providerId: p.id, priority: Math.max(0, p.priority - 1) }, `prio:${p.id}`)}
                  className="rounded border border-line p-1 text-graphite/70 hover:bg-white/5"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <span className="font-mono text-[8px] text-graphite/50">prio {p.priority}</span>
                <button
                  type="button"
                  title="Lower priority"
                  onClick={() => void apply({ providerId: p.id, priority: p.priority + 1 }, `prio:${p.id}`)}
                  className="rounded border border-line p-1 text-graphite/70 hover:bg-white/5"
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
              {p.type !== 'local' && (
                <label className="flex cursor-pointer items-center gap-1" title="Allow this provider to process private tasks">
                  <input
                    type="checkbox"
                    checked={p.trustedForPrivate}
                    onChange={(e) => void apply({ providerId: p.id, trustedForPrivate: e.target.checked }, `trust:${p.id}`)}
                    className="h-3 w-3 accent-cyan-400"
                  />
                  <span className="font-mono text-[8px] text-graphite/60">trusted for private</span>
                </label>
              )}
              <button
                type="button"
                onClick={() => void testProvider(p.id)}
                disabled={busy[`test:${p.id}`]}
                className="ml-auto flex items-center gap-1 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 font-mono text-[8px] tracking-wider text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-50"
              >
                {busy[`test:${p.id}`] ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />} TEST
              </button>
            </div>
            {testResult[`test:${p.id}`] && (
              <p className={`mt-1.5 flex items-center gap-1 font-mono text-[8px] ${testResult[`test:${p.id}`]!.ok ? 'text-emerald-300' : 'text-rose-300'}`}>
                <Activity className="h-2.5 w-2.5" /> {testResult[`test:${p.id}`]!.message}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Explainability */}
      <div className="space-y-2">
        <span className="flex items-center gap-1.5 font-mono text-[10px] tracking-[0.14em] text-graphite/80">
          <HelpCircle className="h-3.5 w-3.5" /> WHY DID YOU CHOOSE THIS MODEL?
        </span>
        <div className="flex gap-2">
          <input
            value={sampleText}
            onChange={(e) => setSampleText(e.target.value)}
            placeholder="Type any request, e.g. 'look at my screen and click the right button'"
            className="min-w-0 flex-1 rounded-xl border border-line bg-black/20 px-3 py-2 font-mono text-[10px] text-zinc-100 placeholder:text-graphite/40 focus:border-emerald-400/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void explainRouting()}
            disabled={explainBusy || !sampleText.trim()}
            className="shrink-0 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 font-mono text-[9px] tracking-wider text-emerald-200 hover:bg-emerald-400/20 disabled:opacity-50"
          >
            {explainBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'EXPLAIN'}
          </button>
        </div>
        {explain && (
          <div className="rounded-xl border border-line bg-black/20 p-3 font-mono text-[9px] leading-relaxed text-zinc-200">
            {explain}
          </div>
        )}
      </div>
    </div>
  );
};
