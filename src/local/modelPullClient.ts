/**
 * modelPullClient.ts — THE one verified model-pull flow shared by the
 * startup wizard and the MY PC tab (v1.9.0).
 *
 * Why this exists (BUG L2, ghost success): the wizard's inline pull loop
 * ended with an unconditional "Model ready ✓" the moment the NDJSON stream
 * closed — even when Ollama had reported an error, and without ever asking
 * Ollama whether the model actually landed. MY PC had already grown the
 * honest flow (stream → verify with /api/tags → only then "installed");
 * duplicating it in the wizard guaranteed the two would drift apart again.
 *
 * Contract every caller gets for free:
 *   phases:  PREPARING → CONNECTING → DOWNLOADING(bytes/%) → VERIFYING → READY
 *   failure: { what, why, fix, retryable } — never a bare string, always an
 *            actionable message with the USE ONLINE MODE escape hatch.
 *   success: ONLY after Ollama's own model list confirms the model exists.
 */

import {
  PullProgressEventLike,
  PullView,
  IDLE_PULL_VIEW,
  foldPullEvent,
  isModelInstalled,
} from './pullClient';

export type PullPhase = 'idle' | 'preparing' | 'connecting' | 'downloading' | 'verifying' | 'ready' | 'error';

export interface PullFailure {
  /** Short verdict — the headline the user sees first. */
  what: string;
  /** The underlying error, verbatim where possible. */
  why: string;
  /** Concrete steps that actually fix it. */
  fix: string;
  retryable: boolean;
}

export interface VerifiedPullState {
  phase: PullPhase;
  model: string | null;
  view: PullView;
  verified: 'pending' | 'confirmed' | 'missing';
  error: PullFailure | null;
}

export const IDLE_VERIFIED_PULL: VerifiedPullState = {
  phase: 'idle',
  model: null,
  view: IDLE_PULL_VIEW,
  verified: 'pending',
  error: null,
};

/**
 * Classifies a raw pull error into the WHAT/WHY/FIX contract. Pure —
 * exhaustively unit-tested in modelPullVerification.test.ts.
 */
export function classifyPullError(raw: string): PullFailure {
  const text = (raw || '').toLowerCase();

  if (/not running|connection refused|econnrefused|cannot reach|fetch failed|daemon/i.test(text)) {
    return {
      what: 'Ollama is not running',
      why: raw,
      fix: 'Start Ollama (open it from the Start Menu — Windows keeps it in the system tray — or run "ollama serve" in a terminal), then press RETRY. Not installed yet? Get it from https://ollama.com/download. Or use Online Mode instead — it needs no local setup.',
      retryable: true,
    };
  }
  if (/disk|space|enospc|storage/i.test(text)) {
    return {
      what: 'Not enough disk space',
      why: raw,
      fix: 'Free up space (the model download needs several GB plus room to unpack) or pick a smaller model from the catalog, then press RETRY. Or use Online Mode instead.',
      retryable: true,
    };
  }
  if (/interrupted|inactivity|no data|timeout|etimedout|aborted mid|stream ended/i.test(text)) {
    return {
      what: 'Download interrupted',
      why: raw,
      fix: 'The network dropped mid-download. Check your connection and press RETRY — Ollama resumes from where it stopped. Or use Online Mode instead.',
      retryable: true,
    };
  }
  if (/not found|pull model manifest|no such|invalid|unauthorized|404|403/i.test(text)) {
    return {
      what: 'Model not available',
      why: raw,
      fix: 'This model tag does not exist (or is private) on the Ollama registry. Choose a different model from the catalog, or update Ollama if it is older than the tag. Or use Online Mode instead.',
      retryable: false,
    };
  }
  return {
    what: 'Model did NOT install',
    why: raw,
    fix: 'Press RETRY to try again. If it keeps failing, run a System Check in Settings → MY PC, or use Online Mode instead (no local setup needed).',
    retryable: true,
  };
}

export interface RunVerifiedPullOptions {
  /** Notified on every phase/byte transition; also receives the final state. */
  onUpdate?: (state: VerifiedPullState) => void;
  signal?: AbortSignal;
  /** Injectable for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

interface LocalStatusLike {
  installedModels: Array<{ name: string }>;
}

function setState(
  current: VerifiedPullState,
  patch: Partial<VerifiedPullState>,
  onUpdate?: (s: VerifiedPullState) => void,
): VerifiedPullState {
  const next = { ...current, ...patch };
  onUpdate?.(next);
  return next;
}

/**
 * Runs the full honest pull flow. Resolves with the FINAL state — callers
 * that only care about the outcome can ignore the onUpdate stream.
 *
 * Never rejects except on AbortError, which is re-thrown so callers can
 * reset their UI exactly like before.
 */
export async function runVerifiedPull(
  model: string,
  options: RunVerifiedPullOptions = {},
): Promise<VerifiedPullState> {
  const doFetch = options.fetchImpl ?? fetch;
  let state: VerifiedPullState = {
    ...IDLE_VERIFIED_PULL,
    phase: 'preparing',
    model,
    view: { ...IDLE_PULL_VIEW, active: true, label: `Preparing to download ${model}…` },
  };
  options.onUpdate?.(state);

  try {
    // ── CONNECTING ──────────────────────────────────────────────────
    state = setState(state, {
      phase: 'connecting',
      view: { ...state.view, label: 'Contacting Ollama…' },
    }, options.onUpdate);

    const response = await doFetch('/api/local/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      // ALWAYS carry the HTTP status — "nope" alone is undebuggable.
      const detail = (await response.text().catch(() => '')).slice(0, 200).trim();
      throw new Error(detail ? `Pull failed (HTTP ${response.status}): ${detail}` : `Pull failed (HTTP ${response.status})`);
    }

    // ── DOWNLOADING ─────────────────────────────────────────────────
    state = setState(state, { phase: 'downloading' }, options.onUpdate);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let carry = '';
    let view: PullView = state.view;
    let streamError: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const lines = carry.split('\n');
      carry = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt: PullProgressEventLike;
        try {
          evt = JSON.parse(line) as PullProgressEventLike;
        } catch {
          continue; // malformed/partial line — not a pull failure
        }
        view = foldPullEvent(view, evt);
        if (view.error) streamError = view.error;
        state = setState(state, { view }, options.onUpdate);
      }
    }

    if (streamError) {
      // Ollama itself reported the failure — NEVER claim success.
      return setState(state, {
        phase: 'error',
        verified: 'missing',
        view: { ...view, active: false, done: true },
        error: classifyPullError(streamError),
      }, options.onUpdate);
    }

    // ── VERIFYING ───────────────────────────────────────────────────
    // The stream closing is NOT success. Ask Ollama's own model list.
    state = setState(state, {
      phase: 'verifying',
      view: { ...view, active: false, fraction: 1, label: 'Verifying install with Ollama…' },
    }, options.onUpdate);

    const statusRes = await doFetch('/api/local/status', { signal: options.signal }).catch(() => null);
    const fresh = statusRes && statusRes.ok ? ((await statusRes.json()) as LocalStatusLike) : null;
    const confirmed = fresh ? isModelInstalled(model, fresh.installedModels) : false;

    if (!confirmed) {
      return setState(state, {
        phase: 'error',
        verified: 'missing',
        view: { ...view, active: false, done: true },
        error: {
          what: 'Install could not be verified',
          why: `Ollama does not list ${model} after the download finished.`,
          fix: 'The model may not have fully unpacked. Press RETRY (Ollama resumes), check free disk space, or pick another model. Or use Online Mode instead.',
          retryable: true,
        },
      }, options.onUpdate);
    }

    // ── READY — genuinely verified ──────────────────────────────────
    return setState(state, {
      phase: 'ready',
      verified: 'confirmed',
      view: { ...view, active: false, done: true, fraction: 1, label: `${model} installed — verified with Ollama` },
    }, options.onUpdate);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return setState(state, {
      phase: 'error',
      verified: 'missing',
      view: { ...state.view, active: false, done: true },
      error: classifyPullError(err instanceof Error ? err.message : String(err)),
    }, options.onUpdate);
  }
}

/** Human label for the current phase (progress cards). */
export function phaseLabel(phase: PullPhase): string {
  switch (phase) {
    case 'preparing': return 'Preparing';
    case 'connecting': return 'Connecting to Ollama';
    case 'downloading': return 'Downloading model';
    case 'verifying': return 'Verifying install';
    case 'ready': return 'Model ready';
    case 'error': return 'Download failed';
    default: return '';
  }
}
