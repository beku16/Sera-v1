/**
 * pullClient.ts — shared client-side logic for Ollama model pulls.
 *
 * Extracted from MyPcTab so it can be unit-tested. Exists because of a
 * real field bug: the old inline parser wrapped each NDJSON line in a
 * try/catch that was ALSO catching its own `throw new Error(evt.error)`,
 * silently swallowing Ollama pull failures and then declaring
 * "<model> installed" even when nothing was installed.
 */

export interface PullProgressEventLike {
  status?: string;
  total?: number | null;
  completed?: number | null;
  fraction?: number | null;
  done?: boolean;
  error?: string;
  /** Server final-line aliases — accepted for compatibility, ignored. */
  completedBytes?: number | null;
  totalBytes?: number | null;
}

export interface PullView {
  active: boolean;
  /** 0..1 — 0 when unknown; the UI clamps the visible bar to a minimum width. */
  fraction: number;
  label: string;
  error: string | null;
  done: boolean;
  completedBytes: number | null;
  totalBytes: number | null;
}

export const IDLE_PULL_VIEW: PullView = {
  active: false,
  fraction: 0,
  label: '',
  error: null,
  done: false,
  completedBytes: null,
  totalBytes: null,
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}

/**
 * Fold one NDJSON progress line into the UI view. Errors are NEVER
 * swallowed: an `{error}` event returns a view with `error` set and
 * `done: true` — the caller must not claim success afterwards.
 */
export function foldPullEvent(prev: PullView, evt: PullProgressEventLike): PullView {
  if (evt.error) {
    return {
      ...prev,
      active: false,
      error: evt.error,
      done: true,
      label: prev.label,
    };
  }

  const total = typeof evt.total === 'number' ? evt.total : prev.totalBytes;
  const completed = typeof evt.completed === 'number' ? evt.completed : prev.completedBytes;
  const fraction =
    typeof evt.fraction === 'number'
      ? evt.fraction
      : total && completed !== null
        ? Math.min(1, completed / total)
        : prev.fraction;

  const isDone = evt.done === true || evt.status === 'complete' || evt.status === 'success';
  const label = evt.status
    ? evt.status === 'complete'
      ? 'Verifying install with Ollama…'
      : evt.status
    : prev.label;

  return {
    active: !isDone,
    fraction: isDone ? 1 : Math.max(prev.fraction, fraction || 0),
    label,
    error: null,
    done: isDone,
    completedBytes: completed,
    totalBytes: total,
  };
}

/** "llama3.2:3b-instruct-q4_K_M" → "llama3.2" */
export function modelFamily(model: string): string {
  return (model.split(':')[0] || '').toLowerCase();
}

/**
 * Post-pull verification: does Ollama's own model list actually contain
 * the model we just pulled? Exact tag match first, then family fallback
 * (Ollama can append/normalize tags). This is what kills the ghost
 * "installed" state — a pull only counts as installed when Ollama lists it.
 */
export function isModelInstalled(model: string, installed: Array<{ name: string }>): boolean {
  if (!model) return false;
  const target = model.toLowerCase();
  const family = modelFamily(model);
  if (!family) return false;
  return installed.some((m) => {
    const name = (m.name || '').toLowerCase();
    if (!name) return false;
    if (name === target) return true;
    return name.split(':')[0] === family;
  });
}
