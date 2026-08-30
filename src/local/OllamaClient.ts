import { execFile } from 'node:child_process';

/**
 * Client for a local Ollama server (default http://127.0.0.1:11434).
 *
 * All network calls are fetch-based with strict timeouts and graceful
 * failure modes: the SERA UI needs honest "Ollama not installed / not
 * running" states instead of stack traces.
 */
export interface OllamaModelSummary {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Ollama tool-call structure (assistant messages). */
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

export interface OllamaChatResponse {
  content: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  model: string;
  totalDurationMs: number;
  evalCount: number | null;
}

export interface PullProgressEvent {
  status: string;
  completedBytes: number | null;
  totalBytes: number | null;
  /** 0..1, null when indeterminate. */
  fraction: number | null;
  done: boolean;
  error?: string;
}

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  installHint: string;
  baseUrl: string;
  /** Honest probe trail — WHY detection succeeded/failed. */
  probeNotes: string[];
}

export interface OllamaClientOptions {
  baseUrl?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

// v1.6.9: exported for regression tests (falsy-zero timeout bug).
export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  // v1.6.9 FIX: `timeoutMs: 0` previously fell through the default because 0
  // is falsy — pullModel (which passes 0 = "stream, no overall timeout")
  // actually got an 8s abort. Real-world result: every multi-GB model pull
  // that took longer than 8s to first byte died with
  // "This operation was aborted". Honor 0/negative as NO timer.
  const { timeoutMs = 8000, ...rest } = init;
  if (!timeoutMs || timeoutMs <= 0) {
    return await fetch(url, rest);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class OllamaClient {
  /** May be re-pointed at runtime when only the `localhost` alias works. */
  private baseUrl: string;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.logger = options.logger ?? console;
  }

  public get endpoint(): string {
    return this.baseUrl;
  }

  /**
   * Detects whether the `ollama` CLI is installed (does NOT require the
   * daemon to be running).
   */
  public async isInstalled(): Promise<{ installed: boolean; version: string | null; hint: string; resolvedPath?: string }> {
    const hint =
      process.platform === 'win32'
        ? 'Install Ollama for Windows from https://ollama.com/download — it runs as a background service automatically.'
        : 'Install Ollama from https://ollama.com/download and run `ollama serve`.';

    const tryVersion = (command: string): Promise<{ stdout: string; spawned: boolean }> =>
      new Promise((resolve) => {
        try {
          execFile(command, ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
            if (err && !stdout) {
              resolve({ stdout: '', spawned: false });
            } else {
              resolve({ stdout: String(stdout || ''), spawned: true });
            }
          });
        } catch {
          resolve({ stdout: '', spawned: false });
        }
      });

    try {
      // 1st try: bare `ollama` on PATH.
      let result = await tryVersion('ollama');
      let resolvedPath: string | undefined;

      // 2nd try (Windows): Ollama's default install location is often NOT
      // on the PATH of spawned server processes (Electron / tsx inherit a
      // stale environment). Probe the well-known install paths explicitly.
      if (!result.spawned && process.platform === 'win32') {
        const fsCheck = await import('node:fs');
        const candidates: string[] = [];
        if (process.env.LOCALAPPDATA) {
          candidates.push(`${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`);
        }
        if (process.env.ProgramFiles) {
          candidates.push(`${process.env.ProgramFiles}\\Ollama\\ollama.exe`);
        }
        for (const candidate of candidates) {
          if (fsCheck.existsSync(candidate)) {
            result = await tryVersion(candidate);
            if (result.spawned) {
              resolvedPath = candidate;
              break;
            }
          }
        }
      }

      const versionMatch = result.stdout.match(/version\s+([\w.-]+)/i) || result.stdout.match(/ollama\s+([\w.-]+)/i);
      return { installed: result.spawned, version: versionMatch ? versionMatch[1] : result.stdout.trim() || null, hint, resolvedPath };
    } catch {
      return { installed: false, version: null, hint };
    }
  }

  /**
   * Checks whether the local Ollama daemon is reachable. Tries the IPv4
   * loopback first, then `localhost` (Ollama sometimes binds ::1 only, and
   * Node resolves localhost → ::1 first on many systems).
   */
  public async isRunning(): Promise<boolean> {
    const candidates = [this.baseUrl];
    try {
      const alt = new URL(this.baseUrl);
      if (alt.hostname === '127.0.0.1') {
        alt.hostname = 'localhost';
        candidates.push(alt.toString().replace(/\/$/, ''));
      }
    } catch { /* keep just the primary */ }

    for (const base of candidates) {
      try {
        const response = await fetchWithTimeout(`${base}/api/version`, { timeoutMs: 2500 });
        if (response.ok) {
          if (base !== this.baseUrl) {
            // Remember the working base for subsequent calls this session.
            this.baseUrl = base;
          }
          return true;
        }
      } catch {
        // try next candidate
      }
    }
    return false;
  }

  /**
   * Full status snapshot used by the startup wizard — includes an honest
   * probe trail so "not detecting anything" always explains itself.
   *
   * IMPORTANT (detection bug fix): a reachable daemon counts as installed
   * even when the CLI binary is not on PATH. On Windows the Ollama service
   * routinely runs while spawned processes inherit a stale PATH — the old
   * logic short-circuited on "CLI missing" and reported Local Mode as
   * unavailable even though inference on http://127.0.0.1:11434 worked
   * perfectly. Now the daemon probe ALWAYS runs.
   */
  public async status(): Promise<OllamaStatus> {
    const probeNotes: string[] = [];
    const install = await this.isInstalled();
    if (install.installed) {
      probeNotes.push(`Ollama CLI found${install.resolvedPath ? ` at ${install.resolvedPath}` : ' on PATH'} (v${install.version ?? '?'}).`);
    } else {
      probeNotes.push('Ollama CLI not found on PATH (also checked %LOCALAPPDATA%\\Programs\\Ollama and %ProgramFiles%\\Ollama on Windows).');
    }

    // Always probe the daemon — the CLI check is advisory only.
    const running = await this.isRunning();
    if (running) {
      probeNotes.push(`Daemon reachable at ${this.baseUrl} — local inference ready.`);
      if (!install.installed) {
        probeNotes.push('CLI binary not on PATH, but the running daemon is enough for SERA — treating Ollama as installed.');
      }
    } else if (install.installed) {
      probeNotes.push(`Daemon NOT reachable at ${this.baseUrl} (connection refused / timeout). Start Ollama: launch it from the Start Menu (Windows keeps it in the tray) or run "ollama serve".`);
    } else {
      probeNotes.push('Neither the CLI nor a local daemon was detected — install Ollama first, then restart SERA and re-open the launcher.');
    }

    return {
      installed: install.installed || running,
      running,
      version: install.version,
      installHint: install.hint,
      baseUrl: this.baseUrl,
      probeNotes,
    };
  }

  /**
   * Lists models currently pulled locally.
   */
  public async listModels(): Promise<OllamaModelSummary[]> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/api/tags`, { timeoutMs: 4000 });
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: Array<{ name?: string; size?: number; modified_at?: string }> };
      return (data.models || []).map((m) => ({
        name: String(m.name || ''),
        sizeBytes: Number(m.size || 0),
        modifiedAt: String(m.modified_at || ''),
      }));
    } catch {
      return [];
    }
  }

  public async hasModel(model: string): Promise<boolean> {
    const models = await this.listModels();
    const target = model.toLowerCase();
    return models.some((m) => m.name.toLowerCase() === target || m.name.toLowerCase().startsWith(`${target}:`) || target.startsWith(`${m.name.toLowerCase()}:`));
  }

  /**
   * Pulls a model, streaming normalized progress events.
   *
   * Ollama's /api/pull emits NDJSON lines like:
   *   {"status":"pulling manifest"}
   *   {"status":"downloading digest","digest":"...","total":4700000000,"completed":120000000}
   *   {"status":"success"}
   * This method parses each line and re-emits a sanitized PullProgressEvent.
   *
   * v1.6.11 FIXES:
   *  - INACTIVITY TIMEOUT: a stalled stream (registry hiccup, dead proxy)
   *    used to hang the HTTP response forever — no overall timeout applies
   *    to multi-GB pulls, so "no data for 90s" now aborts with an honest
   *    error instead of an eternal spinner.
   *  - HONEST STREAM END: a stream that ends WITHOUT a "success" line used
   *    to still return success:true (ghost install). It now fails with a
   *    descriptive error — the client wizard decides what to tell the user.
   */
  public async pullModel(
    model: string,
    onProgress?: (event: PullProgressEvent) => void,
    signal?: AbortSignal,
    options: { inactivityTimeoutMs?: number } = {},
  ): Promise<{ success: boolean; error?: string }> {
    const inactivityTimeoutMs = options.inactivityTimeoutMs ?? 90_000;
    const emit = (event: PullProgressEvent) => {
      try {
        onProgress?.(event);
      } catch (err) {
        this.logger.warn('[OllamaClient] progress listener error:', err);
      }
    };

    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        timeoutMs: 0, // stream — no overall timeout
        signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        const error = `Ollama pull failed (HTTP ${response.status}): ${detail.slice(0, 200)}`;
        emit({ status: 'error', completedBytes: null, totalBytes: null, fraction: null, done: true, error });
        return { success: false, error };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastFraction = 0;
      let sawSuccess = false;
      let inactivityTimer: NodeJS.Timeout | null = null;
      const armInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (inactivityTimeoutMs <= 0) return;
        inactivityTimer = setTimeout(() => {
          try { reader.cancel(`no data from Ollama for ${inactivityTimeoutMs}ms`); } catch { /* reader gone */ }
        }, inactivityTimeoutMs);
        if (typeof inactivityTimer.unref === 'function') inactivityTimer.unref();
      };
      armInactivityTimer();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armInactivityTimer();
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed) as { status?: string; total?: number; completed?: number; error?: string };
              if (parsed.error) {
                emit({ status: 'error', completedBytes: null, totalBytes: null, fraction: null, done: true, error: parsed.error });
                return { success: false, error: parsed.error };
              }
              const total = typeof parsed.total === 'number' ? parsed.total : null;
              const completed = typeof parsed.completed === 'number' ? parsed.completed : null;
              const fraction = total && completed !== null ? Math.min(1, completed / total) : null;
              if (fraction !== null) lastFraction = fraction;
              emit({
                status: parsed.status || 'working',
                completedBytes: completed,
                totalBytes: total,
                fraction: parsed.status === 'success' ? 1 : fraction,
                done: parsed.status === 'success',
              });
              if (parsed.status === 'success') {
                sawSuccess = true;
                return { success: true };
              }
            } catch {
              // Partial JSON line — ignore, next chunk completes it.
            }
          }
        }
      } finally {
        if (inactivityTimer) clearTimeout(inactivityTimer);
      }

      if (sawSuccess) return { success: true };
      const error = `Ollama pull stream ended without a success confirmation (last progress: ${Math.round(lastFraction * 100)}%). The model may not be fully installed — retry the pull.`;
      emit({ status: 'error', completedBytes: null, totalBytes: null, fraction: lastFraction, done: true, error });
      return { success: false, error };
    } catch (err) {
      // v1.8.4: a bare Node "fetch failed" told the user nothing. Connection
      // failures now carry the same honest, actionable fix instructions the
      // chat() path has had since v1.6.11.
      const raw = err instanceof Error ? err.message : String(err);
      const isConnectionFailure = /fetch failed|ECONNREFUSED|ENOTFOUND|EACCES|EHOSTUNREACH|network/i.test(raw);
      const error = isConnectionFailure
        ? `Cannot reach the Ollama engine at ${this.baseUrl} (${raw.slice(0, 120)}). ` +
          `Start Ollama and try again: open "Ollama" from the Start Menu (Windows keeps it in the system tray) ` +
          `or run "ollama serve" in a terminal. If it is not installed yet: https://ollama.com/download. ` +
          `You can also flip to Online Mode with one click in the header.`
        : raw;
      emit({ status: 'error', completedBytes: null, totalBytes: null, fraction: null, done: true, error });
      return { success: false, error };
    }
  }

  /**
   * Non-streaming chat completion with native tool support.
   * Used by the LocalAgentEngine's reasoning loop.
   */
  public async chat(
    input: {
      model: string;
      messages: OllamaChatMessage[];
      tools?: unknown[];
      /** Sampling temperature (lower = more deterministic tool calls). */
      temperature?: number;
    },
    options: { timeoutMs?: number } = {},
  ): Promise<OllamaChatResponse> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          tools: input.tools,
          stream: false,
          options: {
            temperature: input.temperature ?? 0.4,
            num_ctx: 8192,
          },
        }),
        timeoutMs: options.timeoutMs ?? 120000,
      });
    } catch (err) {
      // The daemon is unreachable — the #1 cause of "Local Mode is not working".
      // Give the user the exact 3-step fix plus a 1-click escape hatch instead
      // of a cryptic "fetch failed".
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `I cannot reach the Ollama engine at ${this.baseUrl} (${detail.slice(0, 120)}). ` +
        `Local Mode needs Ollama running on this PC. Fix in 2 minutes: ` +
        `1) Install it from https://ollama.com/download if it is not installed yet. ` +
        `2) Start it — open "Ollama" from the Start Menu (or run "ollama serve" in a terminal). ` +
        `3) Pull the model once: "ollama pull ${input.model}". ` +
        `You can also flip to Online Mode with one click in the header.`
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama chat failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }> };
      model?: string;
      total_duration?: number;
      eval_count?: number;
    };

    const toolCalls = (data.message?.tool_calls || []).map((call) => ({
      name: call.function?.name || '',
      arguments: this.normalizeArguments(call.function?.arguments),
    }));

    return {
      content: data.message?.content || '',
      toolCalls: toolCalls.filter((c) => c.name),
      model: data.model || input.model,
      totalDurationMs: Math.round((data.total_duration || 0) / 1e6),
      evalCount: typeof data.eval_count === 'number' ? data.eval_count : null,
    };
  }

  /** Ollama may deliver arguments as a JSON string — normalize to object. */
  private normalizeArguments(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
      } catch {
        return { value: raw };
      }
    }
    return raw;
  }
}

export const defaultOllamaClient = new OllamaClient();
