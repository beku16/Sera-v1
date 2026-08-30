import React, { useState, useEffect, useCallback } from 'react';
import { KeyRound, Check, Loader2, AlertTriangle, ExternalLink, Trash2, ShieldCheck, Wifi } from 'lucide-react';

/**
 * API Key Manager — dedicated Settings UI (spec A.1.2).
 *
 * Input, instant validation, and deletion of custom provider keys.
 * Keys are stored server-side, AES-256-GCM encrypted at rest; the UI
 * only ever sees masked previews.
 */

interface ProviderMeta {
  id: 'gemini' | 'openai' | 'deepseek';
  label: string;
  keyUrl: string;
  envVar: string;
}

interface VaultEntry {
  provider: ProviderMeta['id'];
  maskedKey: string;
  updatedAt: number;
  lastTest?: { ok: boolean; message: string; testedAt: number };
}

interface TestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
}

const PROVIDER_HELP: Record<ProviderMeta['id'], string> = {
  gemini: 'Powers Online Mode real-time voice (Gemini Live). Required for voice conversations.',
  openai: 'Optional — reserved for future GPT-backed text features.',
  deepseek: 'Optional — reserved for future DeepSeek V3 text features.',
};

export const ApiKeySettingsTab: React.FC = () => {
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, TestResult | undefined>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/keys');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { providers: ProviderMeta[]; entries: VaultEntry[] };
      setProviders(data.providers || []);
      setEntries(data.entries || []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveKey = useCallback(async (provider: ProviderMeta['id'], alsoTest: boolean) => {
    const key = (inputs[provider] || '').trim();
    if (!key) return;
    setSaving((prev) => ({ ...prev, [provider]: true }));
    try {
      const response = await fetch(`/api/keys/${provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, test: alsoTest }),
      });
      const data = (await response.json()) as { entry?: VaultEntry; test?: TestResult; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.entry) {
        setEntries((prev) => [...prev.filter((e) => e.provider !== provider), data.entry!]);
      }
      if (data.test) {
        setResults((prev) => ({ ...prev, [provider]: data.test }));
      }
      setInputs((prev) => ({ ...prev, [provider]: '' }));
    } catch (err) {
      setResults((prev) => ({ ...prev, [provider]: { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: 0 } }));
    } finally {
      setSaving((prev) => ({ ...prev, [provider]: false }));
    }
  }, [inputs]);

  const testExisting = useCallback(async (provider: ProviderMeta['id']) => {
    setTesting((prev) => ({ ...prev, [provider]: true }));
    try {
      const response = await fetch(`/api/keys/${provider}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = (await response.json()) as TestResult & { error?: string };
      setResults((prev) => ({ ...prev, [provider]: response.ok ? data : { ok: false, message: data.error || `HTTP ${response.status}`, latencyMs: 0 } }));
    } catch (err) {
      setResults((prev) => ({ ...prev, [provider]: { ok: false, message: err instanceof Error ? err.message : String(err), latencyMs: 0 } }));
    } finally {
      setTesting((prev) => ({ ...prev, [provider]: false }));
    }
  }, []);

  const deleteKey = useCallback(async (provider: ProviderMeta['id']) => {
    try {
      await fetch(`/api/keys/${provider}`, { method: 'DELETE' });
      setEntries((prev) => prev.filter((e) => e.provider !== provider));
      setResults((prev) => ({ ...prev, [provider]: undefined }));
    } catch { /* best-effort */ }
  }, []);

  const entryFor = (id: ProviderMeta['id']): VaultEntry | undefined => entries.find((e) => e.provider === id);

  return (
    <div className="space-y-5">
      <div>
        <span className="mb-1 flex items-center gap-1.5 font-mono text-[11px] tracking-[0.16em] text-graphite">
          <KeyRound className="h-3.5 w-3.5" /> CUSTOM API KEYS
        </span>
        <p className="font-mono text-[10px] leading-relaxed text-graphite/60">
          Keys are AES-256-GCM encrypted before storage and never displayed in full.
          Environment variables take priority over vault entries.
        </p>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] p-3 font-mono text-[10px] text-rose-200">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> Could not reach the key vault: {loadError}
        </div>
      )}

      <div className="space-y-3">
        {providers.map((provider) => {
          const entry = entryFor(provider.id);
          const result = results[provider.id];
          const inputKey = inputs[provider.id] || '';
          const isSaving = saving[provider.id];
          const isTesting = testing[provider.id];
          return (
            <div key={provider.id} className="rounded-2xl border border-line bg-paper/60 p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-sans text-sm font-bold text-ink">{provider.label}</span>
                  {entry && (
                    <span className="flex items-center gap-1 rounded-full border border-line-strong bg-panel px-2 py-0.5 font-mono text-[9px] font-bold text-graphite">
                      <ShieldCheck className="h-2.5 w-2.5" /> {entry.maskedKey}
                    </span>
                  )}
                </div>
                <a
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-wider text-graphite transition hover:text-ink"
                >
                  Get key <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </div>
              <p className="mb-2.5 font-mono text-[10px] text-graphite/70">{PROVIDER_HELP[provider.id]}</p>

              <div className="flex gap-2">
                <input
                  type="password"
                  value={inputKey}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                  placeholder={entry ? 'Replace with a new key…' : `Paste ${provider.label} API key…`}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-xl border border-line bg-paper px-3 py-2 font-mono text-[11px] text-ink placeholder:text-graphite/50 focus:border-line-strong focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!inputKey.trim() || isSaving}
                  onClick={() => void saveKey(provider.id, true)}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-ink px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-paper transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                  {entry ? 'REPLACE' : 'SAVE'}
                </button>
                {entry && (
                  <>
                    <button
                      type="button"
                      disabled={isTesting}
                      onClick={() => void testExisting(provider.id)}
                      title="Instant connection test"
                      className="flex shrink-0 items-center gap-1.5 rounded-xl border border-line-strong px-3 py-2 font-mono text-[10px] font-bold tracking-wider text-graphite transition hover:bg-panel hover:text-ink disabled:opacity-40"
                    >
                      {isTesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wifi className="h-3 w-3" />}
                      TEST
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteKey(provider.id)}
                      title="Remove stored key"
                      className="flex shrink-0 items-center rounded-xl border border-line px-2.5 py-2 text-graphite transition hover:border-rose-400/40 hover:text-rose-400"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>

              {result && (
                <p className={`mt-2 flex items-start gap-1.5 font-mono text-[10px] leading-relaxed ${result.ok ? 'text-emerald-500' : 'text-rose-400'}`}>
                  {result.ok ? <Check className="mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
                  {result.message}
                </p>
              )}
              {entry?.lastTest && !result && (
                <p className={`mt-2 flex items-start gap-1.5 font-mono text-[10px] ${entry.lastTest.ok ? 'text-emerald-500/80' : 'text-amber-500/80'}`}>
                  {entry.lastTest.ok ? <Check className="mt-0.5 h-3 w-3 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />}
                  Last test: {entry.lastTest.message}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {providers.length === 0 && !loadError && (
        <p className="py-6 text-center font-mono text-[10px] text-graphite/50">Loading providers…</p>
      )}
    </div>
  );
};
