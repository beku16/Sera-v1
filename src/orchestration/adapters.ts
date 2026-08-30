/**
 * SERA — Provider adapters.
 *
 * Each adapter wraps ONE provider API behind the common ProviderAdapter
 * interface, so the orchestrator never knows vendor specifics. All HTTP
 * lives here and only here. Keys resolve env-var-first via ApiKeyVault and
 * are NEVER logged, cached in plaintext, or returned to the renderer.
 */
import { defaultApiKeyVault, type ApiProvider } from '../local/ApiKeyVault';
import { defaultOllamaClient, OllamaClient } from '../local/OllamaClient';
import { ProviderError } from './types';
import type {
  AdapterChatReply,
  AdapterChatRequest,
  FailureKind,
  HealthState,
  ProviderAdapter,
  ProviderDescriptor,
} from './types';

const DEFAULT_TIMEOUT_MS = 60_000;

function mapHttpToKind(status: number, message: string): FailureKind {
  if (status === 401 || status === 403) return 'auth_failure';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'model_unavailable';
  if (status === 400 && /context|too (long|large)|maximum/.test(message)) return 'context_too_large';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

function networkKind(err: unknown): 'timeout' | 'network_failure' {
  const msg = String((err as Error)?.message ?? err ?? '').toLowerCase();
  if (/aborted|timeout|timed out/.test(msg)) return 'timeout';
  return 'network_failure';
}

/** Shared fetch with timeout + error normalization. */
async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    const kind = networkKind(err);
    throw new Error(kind === 'timeout' ? `request timed out after ${timeoutMs} ms` : `network failure: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/* -- Local: Ollama ------------------------------------------------------------ */
export class OllamaAdapter implements ProviderAdapter {
  readonly providerId = 'ollama';

  constructor(private readonly client: OllamaClient = defaultOllamaClient) {}

  async chat(request: AdapterChatRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AdapterChatReply> {
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(request.images && request.images.length > 0 && m.role === 'user' ? { images: request.images } : {}),
    }));
    const started = Date.now();
    try {
      const res = await this.client.chat(
        {
          model: request.model,
          messages: request.system ? [{ role: 'system', content: request.system }, ...messages] : messages,
          temperature: request.temperature,
        },
        { timeoutMs },
      );
      return {
        text: res.content,
        model: res.model ?? request.model,
        tokensOut: res.evalCount,
        // v1.6.11 FIX: this used to report Ollama's TOTAL duration as TTFT —
        // mislabeled telemetry that skewed the router's latency scoring.
        // Non-streaming chat cannot measure true first-token latency, so we
        // report the honest wall-clock round-trip instead.
        ttftMs: Date.now() - started,
      };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/not (running|installed)|ECONNREFUSED|could not reach/i.test(msg)) {
        throw new ProviderError('provider_offline', this.providerId, request.model, msg);
      }
      if (/timeout/i.test(msg)) throw new ProviderError('timeout', this.providerId, request.model, msg);
      if (/context/i.test(msg)) throw new ProviderError('context_too_large', this.providerId, request.model, msg);
      throw new ProviderError('unknown', this.providerId, request.model, msg);
    }
  }

  async probe(): Promise<{ ok: boolean; state: HealthState; message: string; latencyMs?: number }> {
    const running = await this.client.isRunning();
    if (!running) return { ok: false, state: 'offline', message: 'Ollama is not running' };
    const models = await this.client.listModels().catch(() => []);
    return {
      ok: true,
      state: 'healthy',
      message: models.length ? `running with ${models.length} model(s)` : 'running (no models pulled yet)',
    };
  }
}

/* -- Cloud: OpenAI-compatible (Groq / OpenRouter / OpenAI / DeepSeek / custom) -- */
export class OpenAICompatAdapter implements ProviderAdapter {
  constructor(
    readonly providerId: string,
    private readonly baseUrl: string,
    private readonly keyProviderId: string,
  ) {}

  private authHeaders(): Record<string, string> {
    const key = defaultApiKeyVault.resolveKey(this.keyProviderId as ApiProvider);
    if (!key) throw new ProviderError('auth_failure', this.providerId, '', `no API key for ${this.keyProviderId}`);
    return { Authorization: `Bearer ${key}` };
  }

  async chat(request: AdapterChatRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AdapterChatReply> {
    let headers: Record<string, string>;
    try {
      headers = this.authHeaders();
    } catch (err) {
      throw new ProviderError('auth_failure', this.providerId, request.model, String((err as Error).message));
    }
    const messages: unknown[] = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const m of request.messages) {
      if (request.images && request.images.length > 0 && m.role === 'user') {
        messages.push({
          role: m.role,
          content: [
            { type: 'text', text: m.content },
            ...request.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })),
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    const body = {
      model: request.model,
      messages,
      temperature: request.temperature ?? 0.4,
      max_tokens: request.maxTokens ?? 2048,
      stream: false,
    };
    const started = Date.now();
    let res: Response;
    try {
      res = await timedFetch(
        `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        timeoutMs,
      );
    } catch (err) {
      throw new ProviderError(networkKind(err), this.providerId, request.model, String((err as Error)?.message ?? err));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(mapHttpToKind(res.status, text), this.providerId, request.model, `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    if (!content) {
      throw new ProviderError('server_error', this.providerId, request.model, 'empty completion');
    }
    return {
      text: content,
      model: json.model ?? request.model,
      tokensIn: json.usage?.prompt_tokens,
      tokensOut: json.usage?.completion_tokens,
      ttftMs: Date.now() - started,
    };
  }

  async probe(): Promise<{ ok: boolean; state: HealthState; message: string; latencyMs?: number }> {
    const started = Date.now();
    try {
      const headers = this.authHeaders();
      const res = await timedFetch(`${this.baseUrl.replace(/\/$/, '')}/models`, { method: 'GET', headers }, 12_000);
      const latency = Date.now() - started;
      if (res.ok) return { ok: true, state: 'healthy', message: 'reachable, key accepted', latencyMs: latency };
      if (res.status === 401 || res.status === 403) return { ok: false, state: 'invalid_key', message: 'key rejected' };
      if (res.status === 429) return { ok: false, state: 'rate_limited', message: 'rate limited' };
      return { ok: false, state: 'degraded', message: `HTTP ${res.status}`, latencyMs: latency };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      return { ok: false, state: /timed out/i.test(msg) ? 'degraded' : 'offline', message: msg };
    }
  }
}

/* -- Cloud: Google AI Studio (Gemini REST generateContent) --------------------- */
export class GeminiAdapter implements ProviderAdapter {
  readonly providerId = 'gemini';
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  async chat(request: AdapterChatRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<AdapterChatReply> {
    const key = defaultApiKeyVault.resolveKey('gemini');
    if (!key) throw new ProviderError('auth_failure', this.providerId, request.model, 'no Gemini API key configured');
    type GeminiPart = { text?: string; inline_data?: { mime_type: string; data: string } };
    type GeminiContent = { role: string; parts: GeminiPart[] };
    const contents: GeminiContent[] = request.messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const body: Record<string, unknown> = {
      contents,
      generationConfig: { temperature: request.temperature ?? 0.4, maxOutputTokens: request.maxTokens ?? 2048 },
    };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
    // Images attach to the LAST user turn (matches how SERA captures screens).
    if (request.images && request.images.length > 0) {
      const lastUser = [...contents].reverse().find((c) => c.role === 'user');
      if (lastUser) {
        lastUser.parts = [
          ...(lastUser.parts ?? []),
          ...request.images.map((b64) => ({ inline_data: { mime_type: 'image/png', data: b64 } })),
        ];
      }
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await timedFetch(
        `${this.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) },
        timeoutMs,
      );
    } catch (err) {
      throw new ProviderError(networkKind(err), this.providerId, request.model, String((err as Error)?.message ?? err));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ProviderError(mapHttpToKind(res.status, text), this.providerId, request.model, `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const content = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!content) throw new ProviderError('server_error', this.providerId, request.model, 'empty completion');
    return {
      text: content,
      model: request.model,
      tokensIn: json.usageMetadata?.promptTokenCount,
      tokensOut: json.usageMetadata?.candidatesTokenCount,
      ttftMs: Date.now() - started,
    };
  }

  async probe(): Promise<{ ok: boolean; state: HealthState; message: string; latencyMs?: number }> {
    const started = Date.now();
    const key = defaultApiKeyVault.resolveKey('gemini');
    if (!key) return { ok: false, state: 'invalid_key', message: 'no Gemini API key configured' };
    try {
      const res = await timedFetch(`${this.baseUrl}/models`, { method: 'GET', headers: { 'x-goog-api-key': key } }, 12_000);
      const latency = Date.now() - started;
      if (res.ok) return { ok: true, state: 'healthy', message: 'reachable, key accepted', latencyMs: latency };
      if (res.status === 401 || res.status === 403) return { ok: false, state: 'invalid_key', message: 'key rejected' };
      if (res.status === 429) return { ok: false, state: 'rate_limited', message: 'rate limited' };
      return { ok: false, state: 'degraded', message: `HTTP ${res.status}`, latencyMs: latency };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      return { ok: false, state: /timed out/i.test(msg) ? 'degraded' : 'offline', message: msg };
    }
  }
}

/** Build the adapter for a provider descriptor (factory — registry-driven). */
export function createAdapterFor(provider: ProviderDescriptor): ProviderAdapter | null {
  if (provider.type === 'local') return new OllamaAdapter();
  switch (provider.endpoint) {
    case 'https://generativelanguage.googleapis.com/v1beta':
      return new GeminiAdapter();
    default:
      if (/^https?:\/\//.test(provider.endpoint)) {
        return new OpenAICompatAdapter(provider.id, provider.endpoint, provider.keyProviderId ?? provider.id);
      }
      return null;
  }
}
