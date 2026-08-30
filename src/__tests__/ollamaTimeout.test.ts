/**
 * Regression tests for the v1.6.9 Ollama pull abort bug.
 *
 * Field failure: pullModel passes `timeoutMs: 0` ("streaming — no overall
 * timeout") but fetchWithTimeout treated 0 as falsy and fell through to
 * the 8s default. Any pull whose first byte took longer than 8s died with
 * "This operation was aborted" — the user could not install a single
 * model (MY PC tab showed "Pull failed — NOT installed: This operation
 * was aborted").
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWithTimeout } from '../local/OllamaClient';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchWithTimeout — timeoutMs: 0 means NO timeout (v1.6.9)', () => {
  it('never aborts a pending request when timeoutMs is 0 (old bug: 8s default applied)', async () => {
    vi.useFakeTimers();
    const abortSpy = vi.fn();
    // A fetch that stays pending and reports aborts.
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortSpy();
          reject(new Error('AbortError'));
        });
      }),
    );

    const promise = fetchWithTimeout('http://127.0.0.1:11434/api/pull', {
      timeoutMs: 0,
      method: 'POST',
    });

    // Advance far past the old accidental 8s default — an unfixed build
    // would have aborted here.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(abortSpy).not.toHaveBeenCalled();

    // Clean up: abort via a never-resolving guard and swallow.
    void promise.catch(() => undefined);
    // Detach — fake timers won't settle this promise; that is the point.
  });

  it('still aborts with a POSITIVE timeoutMs (mechanism intact)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      }),
    );

    // Normalize the outcome so no rejection escapes the test boundary.
    const outcome = fetchWithTimeout('http://127.0.0.1:11434/api/tags', { timeoutMs: 100 }).then(
      () => 'resolved',
      (err: unknown) => `aborted:${(err as { name?: string }).name ?? 'unknown'}`,
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(await outcome).toBe('aborted:AbortError');
  });
});
