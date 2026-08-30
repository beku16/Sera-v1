/**
 * v1.8.4 regression tests — honest model-pull failures.
 *
 * Field failure (user's screenshot): clicking INSTALL in the MY PC tab
 * while Ollama was not installed/running produced
 *   "Pull failed – NOT installed: fetch failed"
 * — a raw Node fetch error with zero guidance. The pull path now
 * (a) translates connection failures into the same actionable fix
 *     instructions the chat() path has used since v1.6.11, and
 * (b) is pre-checked by the /api/local/pull endpoint before any fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaClient } from '../local/OllamaClient';

const silentLogger = { log: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OllamaClient.pullModel — honest connection errors (v1.8.4)', () => {
  it('translates a raw "fetch failed" into actionable fix instructions', async () => {
    // Exactly what Node's fetch throws when nothing listens on 127.0.0.1:11434.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', logger: silentLogger });
    const events: Array<{ error?: string }> = [];
    const result = await client.pullModel('llama3.2:3b-instruct-q4_K_M', (event) => events.push(event));

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    // The old bug: the error was the bare "fetch failed".
    expect(result.error).not.toBe('fetch failed');
    // The new message tells the user WHAT to do, not just what broke.
    expect(result.error).toMatch(/Cannot reach the Ollama engine at http:\/\/127\.0\.0\.1:11434/);
    expect(result.error).toMatch(/ollama serve|Start Menu/);
    expect(result.error).toMatch(/https:\/\/ollama\.com\/download/);
    expect(result.error).toMatch(/Online Mode/);
    // The streamed progress event carries the same honest error.
    const errorEvent = events.find((e) => Boolean(e.error));
    expect(errorEvent?.error).toBe(result.error);
  });

  it('keeps stream-level errors verbatim (no over-wrapping)', async () => {
    // Ollama IS running and answers with its own error (e.g. registry 404).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"pull model manifest: file does not exist"}\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));

    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', logger: silentLogger });
    const result = await client.pullModel('nope:latest');

    expect(result.success).toBe(false);
    expect(result.error).toBe('pull model manifest: file does not exist');
  });

  it('passes an explicit abort signal through to the fetch (wizard cancel)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', logger: silentLogger });
    const result = await client.pullModel('llama3.2:3b', undefined, controller.signal);

    expect(result.success).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/pull',
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
