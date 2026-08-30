import { describe, it, expect, vi } from 'vitest';
import {
  runVerifiedPull,
  classifyPullError,
  phaseLabel,
  IDLE_VERIFIED_PULL,
} from '../local/modelPullClient';

/**
 * BUG L2 regression suite: a pull may ONLY report success after Ollama's
 * own model list confirms the model. The startup wizard used to print
 * "Model ready ✓" unconditionally when the stream ended — even after an
 * Ollama error event.
 */

function ndjsonResponse(lines: unknown[]): Response {
  const body = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('classifyPullError — WHAT/WHY/FIX contract', () => {
  it('classifies daemon-down errors with restart instructions', () => {
    const failure = classifyPullError('Ollama is not running, so the model cannot be downloaded.');
    expect(failure.what).toMatch(/not running/i);
    expect(failure.fix).toMatch(/ollama serve/i);
    expect(failure.fix).toMatch(/Online Mode/i);
    expect(failure.retryable).toBe(true);
  });

  it('classifies disk-space errors (spec §19 pre-check text)', () => {
    const failure = classifyPullError('Not enough disk space: the model needs about 5170 MB');
    expect(failure.what).toMatch(/disk space/i);
    expect(failure.fix).toMatch(/free up space|smaller model/i);
    expect(failure.retryable).toBe(true);
  });

  it('classifies interrupted downloads as resumable', () => {
    const failure = classifyPullError('no data from Ollama for 90000ms');
    expect(failure.what).toMatch(/interrupted/i);
    expect(failure.fix).toMatch(/resum/i);
  });

  it('classifies dead registry tags as not retryable', () => {
    const failure = classifyPullError('pull model manifest: file does not exist');
    expect(failure.what).toMatch(/not available/i);
    expect(failure.retryable).toBe(false);
  });

  it('falls back to an honest generic failure', () => {
    const failure = classifyPullError('something exotic');
    expect(failure.what).toMatch(/did NOT install/i);
    expect(failure.fix.length).toBeGreaterThan(20);
  });
});

describe('runVerifiedPull — phase machine', () => {
  it('reaches ready ONLY when Ollama lists the model after the stream', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          { status: 'pulling manifest' },
          { status: 'downloading digest', total: 1000, completed: 400 },
          { status: 'downloading digest', total: 1000, completed: 1000 },
          { status: 'success' },
        ]),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ installedModels: [{ name: 'llama3.2:3b-instruct-q4_K_M' }] }), { status: 200 }),
      );

    const phases: string[] = [];
    const final = await runVerifiedPull('llama3.2:3b-instruct-q4_K_M', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onUpdate: (s) => phases.push(s.phase),
    });

    expect(final.phase).toBe('ready');
    expect(final.verified).toBe('confirmed');
    expect(final.view.label).toMatch(/verified with Ollama/i);
    // Phase progression observed by the UI.
    expect(phases).toContain('connecting');
    expect(phases).toContain('downloading');
    expect(phases).toContain('verifying');
    expect(phases).toContain('ready');
  });

  it('BUG L2: NEVER reports ready when Ollama reports an error mid-stream', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        ndjsonResponse([
          { status: 'downloading digest', total: 1000, completed: 900 },
          { error: 'io: read/write on closed pipe' },
        ]),
      );

    const final = await runVerifiedPull('qwen2.5:7b-instruct-q4_K_M', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(final.phase).toBe('error');
    expect(final.verified).toBe('missing');
    expect(final.view.label).not.toMatch(/ready/i);
    // No verification fetch — the stream itself failed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('BUG L2: stream success WITHOUT the model in /api/tags is a failure, not "ready ✓"', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ndjsonResponse([{ status: 'success' }]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ installedModels: [] }), { status: 200 }));

    const final = await runVerifiedPull('phi3.5:3.8b-mini-instruct-q4_K_M', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(final.phase).toBe('error');
    expect(final.error?.what).toMatch(/could not be verified/i);
    expect(final.verified).toBe('missing');
  });

  it('rethrows AbortError so callers can reset their UI', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return Promise.resolve(ndjsonResponse([]));
    });
    await expect(
      runVerifiedPull('qwen2.5:1.5b-instruct-q4_K_M', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('wraps HTTP failures in the WHAT/WHY/FIX contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const final = await runVerifiedPull('qwen3:4b', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(final.phase).toBe('error');
    expect(final.error?.why).toMatch(/HTTP 500/);
  });
});

describe('phaseLabel', () => {
  it('labels every phase for the progress cards', () => {
    expect(phaseLabel('downloading')).toMatch(/downloading/i);
    expect(phaseLabel('verifying')).toMatch(/verifying/i);
    expect(phaseLabel('ready')).toMatch(/ready/i);
    expect(phaseLabel('error')).toMatch(/failed/i);
    expect(phaseLabel('idle')).toBe('');
  });

  it('idle state is neutral', () => {
    expect(IDLE_VERIFIED_PULL.phase).toBe('idle');
    expect(IDLE_VERIFIED_PULL.model).toBeNull();
    expect(IDLE_VERIFIED_PULL.error).toBeNull();
  });
});
