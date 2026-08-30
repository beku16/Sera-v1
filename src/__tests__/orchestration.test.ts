/**
 * Model Orchestration test suite — covers the spec's required scenarios:
 * provider registration, capability matching, free-first routing, paid
 * blocking, task classification, fallback, rate limits, timeouts, invalid
 * keys, offline mode, local fallback, vision/coding/voice selection,
 * privacy routing, provider health, cost tracking, performance history.
 *
 * Fully hermetic: fake adapters + injected credential resolver + temp data
 * dirs. Zero network, zero dependence on the developer's real vault.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ModelOrchestrator,
  TaskClassifier,
  ProviderRegistry,
  ProviderHealthMonitor,
  CostController,
  PerformanceMemory,
  classifyFailure,
  recoveryStrategy,
  ProviderError,
} from '../orchestration/index';
import type { ProviderAdapter, AdapterChatReply } from '../orchestration/types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sera-orch-'));
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Deterministic fake adapter: scriptable replies/failures per provider. */
interface FakeBehavior {
  ok: boolean;
  reply?: Partial<AdapterChatReply>;
  error?: unknown;
}

function fakeAdapter(
  providerId: string,
  behavior: () => FakeBehavior,
): ProviderAdapter {
  return {
    providerId,
    async chat(): Promise<AdapterChatReply> {
      const r = behavior();
      if (!r.ok) throw r.error ?? new Error(`fake failure from ${providerId}`);
      return { text: `reply from ${providerId}`, model: 'fake-model', tokensIn: 10, tokensOut: 5, ttftMs: 12, ...r.reply };
    },
    async probe() {
      const r = behavior();
      return r.ok ? { ok: true, state: 'healthy' as const, message: 'ok' } : { ok: false, state: 'offline' as const, message: 'down' };
    },
  };
}

describe('TaskClassifier', () => {
  const classifier = new TaskClassifier();

  it('classifies wake responses as latency-critical fast tasks', () => {
    const c = classifier.classify('hey sera');
    expect(c.taskType).toBe('wake_response');
    expect(c.latencyCritical).toBe(true);
    expect(c.complexity).toBeLessThanOrEqual(2);
  });

  it('classifies screen questions as vision tasks requiring vision capability', () => {
    const c = classifier.classify('look at my screen and tell me what you see');
    expect(c.taskType).toBe('vision');
    expect(c.requires).toContain('vision');
  });

  it('classifies screen-button tasks as screen_control with vision', () => {
    const c = classifier.classify('which button should I click on my screen');
    expect(['screen_control', 'vision']).toContain(c.taskType);
    expect(c.requires).toContain('vision');
  });

  it('classifies coding and debugging tasks', () => {
    expect(classifier.classify('write a function that parses csv in python').taskType).toBe('coding');
    expect(classifier.classify('this error says cannot read property of undefined, stack trace inside').taskType).toBe('debugging');
  });

  it('classifies translation, summarization, memory, planning', () => {
    expect(classifier.classify('translate this to spanish: good morning').taskType).toBe('translation');
    expect(classifier.classify('summarize this article for me, tldr please').taskType).toBe('summarization');
    expect(classifier.classify('remember that I prefer dark mode').taskType).toBe('memory');
    expect(classifier.classify('plan a step by step roadmap to learn guitar').taskType).toBe('planning');
  });

  it('flags long inputs as long_context', () => {
    const c = classifier.classify('a'.repeat(7000));
    expect(c.requires).toContain('long_context');
  });

  it('routes browser automation to tool-capable models', () => {
    const c = classifier.classify('open the website github.com and search the web for sera');
    expect(c.taskType).toBe('browser_automation');
    expect(c.requires).toContain('tool_calling');
  });

  it('marks secrets as highly private and personal files as private', () => {
    expect(classifier.classify('my password is hunter2').privacy).toBe('highly_private');
    expect(classifier.classify('read my personal documents folder').privacy).toBe('private');
  });

  it('marks generic knowledge as public/normal', () => {
    const c = classifier.classify('who won the world cup in 2010?');
    expect(['public', 'normal']).toContain(c.privacy);
    expect(c.taskType).toBe('simple_qa');
  });

  it('classifies planning subtasks for multi-model execution', () => {
    const c = classifier.classifySubtask('open notepad and type the summary');
    expect(c.taskType).toBe('tool_execution');
    expect(c.requires).toContain('tool_calling');
  });
});

describe('ProviderRegistry', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmDir(dir);
  });

  it('seeds local, free and paid providers with honest tiers', () => {
    const registry = new ProviderRegistry(dir);
    const ids = registry.list().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['ollama', 'groq', 'openrouter', 'gemini', 'openai']));
    const openai = registry.get('openai')!;
    expect(openai.type).toBe('paid');
    expect(openai.enabled).toBe(false);
    expect(openai.userAuthorized).toBe(false);
    const ollama = registry.get('ollama')!;
    expect(ollama.type).toBe('local');
    expect(ollama.enabled).toBe(true);
    expect(ollama.models.length).toBeGreaterThanOrEqual(4);
  });

  it('enable/disable/prioritize persist across instances', () => {
    const r1 = new ProviderRegistry(dir);
    expect(r1.setEnabled('groq', false)).toBe(true);
    expect(r1.setPriority('groq', 5)).toBe(true);
    const r2 = new ProviderRegistry(dir);
    expect(r2.get('groq')!.enabled).toBe(false);
    expect(r2.get('groq')!.priority).toBe(5);
  });

  it('adds and removes custom OpenAI-compatible providers', () => {
    const registry = new ProviderRegistry(dir);
    registry.upsertCustomProvider({
      id: 'mynode',
      name: 'My vLLM node',
      type: 'free',
      endpoint: 'http://192.168.1.20:8000/v1',
      authMethod: 'none',
      models: [],
      enabled: true,
      priority: 3,
      freeTier: 'user_confirmed',
      trustedForPrivate: true,
    });
    expect(registry.get('mynode')!.trustedForPrivate).toBe(true);
    expect(registry.removeCustomProvider('mynode')).toBe(true);
    expect(registry.get('mynode')).toBeNull();
  });

  it('survives a corrupt persistence file', () => {
    fs.writeFileSync(path.join(dir, 'sera_providers.json'), '{not json');
    const registry = new ProviderRegistry(dir);
    expect(registry.get('ollama')).not.toBeNull();
  });
});

describe('ModelRouter — free-first scoring and hard gates', () => {
  let dir: string;
  let orchestrator: ModelOrchestrator;

  beforeEach(() => {
    dir = tmpDir();
    // Hermetic: only gemini appears to have a key, so cloud candidates are
    // deterministic; ollama wins free-first scoring on its own merits.
    orchestrator = new ModelOrchestrator(dir, undefined, {
      credentialResolver: (id) => (id === 'gemini' ? 'test-key' : null),
    });
  });
  afterEach(() => {
    rmDir(dir);
  });

  it('prefers LOCAL ollama for wake-response voice traffic (free-first)', () => {
    const decision = orchestrator.routeOnly({ text: 'hey sera', taskType: 'wake_response' });
    expect(decision.selected).not.toBeNull();
    expect(decision.selected!.providerId).toBe('ollama');
    expect(decision.selected!.providerType).toBe('local');
  });

  it('routes vision requests ONLY to vision-capable models', () => {
    const decision = orchestrator.routeOnly({ text: 'look at my screen', hasImages: true });
    expect(decision.requires).toContain('vision');
    expect(decision.selected!.providerId).toBe('gemini'); // only vision seed available
    for (const c of decision.candidates) expect(c.providerId).not.toBe('ollama'); // local text models have no vision
  });

  it('rejects paid providers by default (paid locked OFF)', () => {
    const decision = orchestrator.routeOnly({ text: 'write a complex system', taskType: 'coding' });
    expect(['openai', 'deepseek']).not.toContain(decision.selected!.providerId);
    // The critical guarantee: no paid candidate is ever selectable.
    for (const c of decision.candidates) expect(c.providerType).not.toBe('paid');
  });

  it('a user-enabled paid provider STILL requires the global paid switch', () => {
    // Arm the key so the credential gate passes and the PAID gate is what rejects.
    const armed = new ModelOrchestrator(dir, undefined, {
      credentialResolver: (id) => (id === 'gemini' || id === 'openai' ? 'k' : null),
    });
    armed.registry.setEnabled('openai', true);
    const decision = armed.routeOnly({ text: 'complex coding task', taskType: 'coding' });
    const openaiReject = decision.rejected.find((r) => r.providerId === 'openai');
    expect(openaiReject).toBeTruthy();
    expect(openaiReject!.reason).toMatch(/locked OFF/);
  });

  it('keeps highly private content strictly local', () => {
    const decision = orchestrator.routeOnly({ text: 'my password is correct-horse-battery', taskType: 'conversation' });
    expect(decision.privacy).toBe('highly_private');
    expect(decision.selected!.providerType).toBe('local');
    const cloud = decision.candidates.filter((c) => c.providerType !== 'local');
    expect(cloud).toHaveLength(0);
  });

  it('keeps private content off untrusted cloud providers', () => {
    const decision = orchestrator.routeOnly({ text: 'summarize my personal documents' });
    expect(decision.privacy).toBe('private');
    expect(decision.selected!.providerType).toBe('local');
    const geminiReject = decision.rejected.find((r) => r.providerId === 'gemini');
    expect(geminiReject!.reason).toMatch(/private/);
  });

  it('a cloud provider the user marks trusted may serve private tasks', () => {
    orchestrator.setProviderTrustedForPrivate('gemini', true);
    const decision = orchestrator.routeOnly({ text: 'summarize my personal documents' });
    expect(decision.candidates.some((c) => c.providerId === 'gemini')).toBe(true);
  });

  it('routing mode local_first keeps everything local even for hard tasks', () => {
    orchestrator.setRoutingMode('local_first');
    const decision = orchestrator.routeOnly({ text: 'explain this complicated stack trace and fix my code' });
    expect(decision.routingMode).toBe('local_first');
    expect(decision.selected!.providerType).toBe('local');
  });

  it('context-fit: huge prompts reject small-context models', () => {
    const decision = orchestrator.routeOnly({ text: 'x'.repeat(500000) });
    expect(decision.rejected.some((r) => /context too large/.test(r.reason))).toBe(true);
  });

  it('explains the routing decision in human language', () => {
    const decision = orchestrator.routeOnly({ text: 'hey', taskType: 'wake_response' });
    expect(decision.rationale.length).toBeGreaterThan(20);
    expect(decision.rationale).toMatch(/local|free|healthy/i);
  });

  it('coding tasks rank coding-capable models to the top', () => {
    const decision = orchestrator.routeOnly({ text: 'refactor this typescript module', taskType: 'coding' });
    expect(decision.selected!.modelId).toMatch(/qwen2\.5:7b/); // strongest local coder in the seed catalog
  });
});

describe('ProviderHealthMonitor', () => {
  it('tracks success, degraded latency and EMA', () => {
    const monitor = new ProviderHealthMonitor();
    monitor.recordSuccess('p', 500);
    monitor.recordSuccess('p', 1000);
    const snap = monitor.snapshot('p');
    expect(snap.state).toBe('healthy');
    expect(snap.avgLatencyMs).toBeGreaterThan(500);
    expect(snap.successRate).toBe(1);
  });

  it('auth failure -> invalid_key and unusable until manually reset', () => {
    const monitor = new ProviderHealthMonitor();
    monitor.recordFailure('p', 'auth_failure');
    expect(monitor.snapshot('p').state).toBe('invalid_key');
    expect(monitor.isUsable('p')).toBe(false);
    monitor.setState('p', 'healthy');
    expect(monitor.isUsable('p')).toBe(true);
  });

  it('rate limit -> cooldown that auto-recovers', () => {
    const monitor = new ProviderHealthMonitor();
    monitor.recordFailure('p', 'rate_limit');
    expect(monitor.snapshot('p').state).toBe('rate_limited');
    expect(monitor.isUsable('p')).toBe(false);
    const snap = monitor.snapshot('p');
    snap.cooldownUntil = Date.now() - 1; // simulate cooldown expiry
    expect(monitor.isUsable('p')).toBe(true);
  });

  it('offline has a cooldown too; unknown providers are usable', () => {
    const monitor = new ProviderHealthMonitor();
    expect(monitor.isUsable('never-seen')).toBe(true);
    monitor.recordFailure('p', 'network_failure');
    expect(monitor.isUsable('p')).toBe(false);
  });

  it('timeout twice escalates to offline', () => {
    const monitor = new ProviderHealthMonitor();
    monitor.recordFailure('p', 'timeout');
    expect(monitor.snapshot('p').state).toBe('degraded');
    monitor.recordFailure('p', 'timeout');
    expect(monitor.snapshot('p').state).toBe('offline');
  });
});

describe('CostController — the money guard', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    rmDir(dir);
  });

  it('paid is OFF by default and persists as OFF', () => {
    expect(new CostController(dir).allowsPaid()).toBe(false);
    new CostController(dir).setAllowPaid(true);
    const fresh = new CostController(dir);
    expect(fresh.summary().allowPaidProviders).toBe(true);
  });

  it('estimateCostUsd is zero for free/local, positive for paid', () => {
    const cost = new CostController(dir);
    expect(cost.estimateCostUsd('local', 'qwen2.5:7b', 1000, 1000)).toBe(0);
    expect(cost.estimateCostUsd('free', 'llama-3.3-70b-versatile', 1000, 1000)).toBe(0);
    expect(cost.estimateCostUsd('paid', 'gpt-4o', 1000, 1000)).toBeGreaterThan(0);
  });

  it('budget caps stop paid usage', () => {
    const cost = new CostController(dir);
    cost.setAllowPaid(true);
    cost.setBudgets(0.01, 1);
    cost.recordSpend(0.02);
    expect(cost.allowsPaid()).toBe(false);
  });

  it('spend is recorded per day and month', () => {
    const cost = new CostController(dir);
    cost.setAllowPaid(true);
    cost.recordSpend(0.5);
    const s = cost.summary();
    expect(s.spentTodayUsd).toBeCloseTo(0.5);
    expect(s.spentThisMonthUsd).toBeCloseTo(0.5);
  });
});

describe('FallbackManager — failure classification', () => {
  it('maps HTTP statuses to failure kinds', () => {
    expect(classifyFailure({ error: new Error('x'), providerId: 'p', modelId: 'm', status: 401 })).toBe('auth_failure');
    expect(classifyFailure({ error: new Error('x'), providerId: 'p', modelId: 'm', status: 429 })).toBe('rate_limit');
    expect(classifyFailure({ error: new Error('x'), providerId: 'p', modelId: 'm', status: 500 })).toBe('server_error');
  });

  it('maps message/code patterns', () => {
    expect(classifyFailure({ error: new Error('ENOTFOUND api.groq.com'), providerId: 'p', modelId: 'm' })).toBe('network_failure');
    expect(classifyFailure({ error: new Error('request aborted after timeout'), providerId: 'p', modelId: 'm' })).toBe('timeout');
    expect(classifyFailure({ error: new Error('maximum context length exceeded'), providerId: 'p', modelId: 'm' })).toBe('context_too_large');
    expect(classifyFailure({ error: new Error('API key not valid'), providerId: 'p', modelId: 'm' })).toBe('auth_failure');
  });

  it('classifies ProviderError kinds directly', () => {
    expect(classifyFailure({ error: new ProviderError('rate_limit', 'p', 'm', '429'), providerId: 'p', modelId: 'm' })).toBe('rate_limit');
  });

  it('strategies differ per failure kind', () => {
    expect(recoveryStrategy('auth_failure').userActionRequired).toBe(true);
    expect(recoveryStrategy('network_failure').preferLocalNext).toBe(true);
    expect(recoveryStrategy('model_unavailable').retrySameProvider).toBe(true);
    expect(recoveryStrategy('context_too_large').needsBiggerContext).toBe(true);
  });
});

describe('ModelOrchestrator — end-to-end routing and fallback', () => {
  let dir: string;
  let keys: Record<string, string>;
  let ollamaBehavior: () => FakeBehavior;
  let cloudAdapters: Record<string, ProviderAdapter>;
  let orchestrator: ModelOrchestrator;

  beforeEach(() => {
    dir = tmpDir();
    keys = {};
    ollamaBehavior = () => ({ ok: true as const });
    cloudAdapters = {};
    rebuild();
  });

  function rebuild(): void {
    orchestrator = new ModelOrchestrator(dir, fakeAdapter('ollama', ollamaBehavior), {
      credentialResolver: (id) => keys[id] ?? null,
    });
    for (const [id, adapter] of Object.entries(cloudAdapters)) {
      (orchestrator as unknown as { adapters: Map<string, ProviderAdapter> }).adapters.set(id, adapter);
    }
  }

  afterEach(() => {
    rmDir(dir);
  });

  it('generates via the selected local provider and records telemetry', async () => {
    const result = await orchestrator.generate({ text: 'hey sera', taskType: 'wake_response' });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('reply from ollama');
    expect(result.decision.selected!.providerId).toBe('ollama');
    expect(result.telemetry.success).toBe(true);
    expect(result.telemetry.localOrCloud).toBe('local');
    expect(result.telemetry.freeOrPaid).toBe('free');
    expect(result.telemetry.requestId).toMatch(/^req_/);
    expect(result.explanation).toMatch(/local/i);
  });

  it('falls back to the next candidate when the first provider fails', async () => {
    keys.gemini = 'fake-key';
    cloudAdapters.gemini = fakeAdapter('gemini', () => ({ ok: true as const }));
    ollamaBehavior = () => ({ ok: false as const, error: new ProviderError('provider_offline', 'ollama', 'm', 'ECONNREFUSED') });
    rebuild();
    const result = await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    expect(result.ok).toBe(true);
    expect(result.attempts[0].providerId).toBe('ollama');
    expect(result.attempts[0].ok).toBe(false);
    expect(result.attempts.at(-1)!.providerId).toBe('gemini');
    expect(result.attempts.at(-1)!.ok).toBe(true);
    expect(result.telemetry.fallbackUsed).toBe(true);
    expect(result.telemetry.providerId).toBe('gemini');
    expect(result.text).toBe('reply from gemini');
  });

  it('never retries the same dead candidate after preferLocalNext re-sorting', async () => {
    keys.gemini = 'fake-key';
    cloudAdapters.gemini = fakeAdapter('gemini', () => ({ ok: true as const }));
    ollamaBehavior = () => ({ ok: false as const, error: new ProviderError('provider_offline', 'ollama', 'm', 'down') });
    rebuild();
    const result = await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    const ollamaAttempts = result.attempts.filter((a) => a.providerId === 'ollama');
    expect(ollamaAttempts).toHaveLength(1); // the old bug retried it 4 times
  });

  it('offline mode: zero keys + ollama down -> structured failure, no crash', async () => {
    ollamaBehavior = () => ({ ok: false as const, error: new ProviderError('provider_offline', 'ollama', 'm', 'ECONNREFUSED') });
    rebuild();
    const result = await orchestrator.generate({ text: 'hello there friend' });
    expect(result.ok).toBe(false);
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(result.error).toBeTruthy();
    expect(result.explanation.toLowerCase()).toMatch(/no eligible model|failed/);
  });

  it('auth failure marks provider invalid and skips it on the next request', async () => {
    keys.gemini = 'bad-key';
    cloudAdapters.gemini = fakeAdapter('gemini', () => ({
      ok: false as const,
      error: new ProviderError('auth_failure', 'gemini', 'gemini-2.0-flash', 'API key not valid', 401),
    }));
    ollamaBehavior = () => ({ ok: false as const, error: new ProviderError('provider_offline', 'ollama', 'm', 'down') });
    rebuild();
    const r1 = await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    expect(r1.attempts.some((a) => a.providerId === 'gemini' && !a.ok)).toBe(true);
    const r2 = await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    const geminiReject = r2.decision.rejected.find((r) => r.providerId === 'gemini');
    expect(geminiReject).toBeTruthy();
    expect(geminiReject!.reason).toMatch(/health: invalid_key/);
  });

  it('paid providers stay unreachable even when everything else fails', async () => {
    keys.openai = 'paid-key';
    let openaiCalls = 0;
    cloudAdapters.openai = {
      providerId: 'openai',
      async chat() {
        openaiCalls += 1;
        return { text: 'paid answer', model: 'gpt-4o' };
      },
      async probe() {
        return { ok: true, state: 'healthy' as const, message: 'ok' };
      },
    };
    ollamaBehavior = () => ({ ok: false as const, error: new ProviderError('provider_offline', 'ollama', 'm', 'down') });
    rebuild();
    orchestrator.registry.setEnabled('openai', true); // even user-enabled...
    const result = await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    expect(result.ok).toBe(false);
    expect(result.attempts.some((a) => a.providerId === 'openai')).toBe(false);
    expect(openaiCalls).toBe(0); // ...and never actually invoked
  });

  it('respects explicit privacy override over content-based classification', async () => {
    const result = await orchestrator.generate({ text: 'hello', privacy: 'highly_private', taskType: 'conversation' });
    expect(result.decision.privacy).toBe('highly_private');
    expect(result.decision.selected!.providerType).toBe('local');
  });

  it('rate-limited provider is skipped while the cooldown is active', async () => {
    keys.gemini = 'fake-key';
    cloudAdapters.gemini = fakeAdapter('gemini', () => ({ ok: true as const }));
    ollamaBehavior = () => ({ ok: false as const, error: new ProviderError('rate_limit', 'ollama', 'm', 'too many requests') });
    rebuild();
    // First: ollama rate-limits -> failover to gemini succeeds.
    const r1 = await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    expect(r1.ok).toBe(true);
    expect(r1.telemetry.providerId).toBe('gemini');
    // Health now: ollama rate_limited. Next request routes straight to gemini.
    const r2 = await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    expect(r2.decision.selected!.providerId).toBe('gemini');
    const ollamaReject = r2.decision.rejected.find((r) => r.providerId === 'ollama');
    expect(ollamaReject!.reason).toMatch(/health: rate_limited/);
  });

  it('performance memory nudges later decisions (successful model favored)', async () => {
    keys.gemini = 'fake-key';
    cloudAdapters.gemini = fakeAdapter('gemini', () => ({ ok: true as const, reply: { ttftMs: 30 } }));
    ollamaBehavior = () => ({ ok: false as const, error: new ProviderError('provider_offline', 'ollama', 'm', 'down') });
    rebuild();
    for (let i = 0; i < 13; i += 1) {
      await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    }
    // Now ollama "recovers"; gemini's accumulated history keeps it competitive
    // at the top of the candidate list.
    ollamaBehavior = () => ({ ok: true as const });
    rebuild();
    const decision = orchestrator.routeOnly({ text: 'hey', taskType: 'wake_response' });
    expect(decision.candidates.length).toBeGreaterThan(1);
    const gemini = decision.candidates.find((c) => c.providerId === 'gemini');
    expect(gemini).toBeTruthy();
    expect(gemini!.breakdown.reliabilityScore).toBeGreaterThan(4); // history bonus applied
  });

  it('status() reports providers, health, cost and telemetry without leaking keys', async () => {
    keys.gemini = 'secret-gemini-key';
    rebuild();
    await orchestrator.generate({ text: 'hey', taskType: 'wake_response' });
    const status = orchestrator.status();
    expect(status.routingMode).toBe('free_first');
    expect(status.providers.find((p) => p.id === 'gemini')!.hasKey).toBe(true);
    expect(status.telemetry.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('secret-gemini-key');
  });
});

describe('PerformanceMemory', () => {
  it('needs a minimum sample before influencing scores', () => {
    const dir = tmpDir();
    const mem = new PerformanceMemory(dir);
    mem.record('p', 'm', 'coding', true, 100);
    mem.record('p', 'm', 'coding', true, 100);
    expect(mem.scoreAdjustment('p', 'm', 'coding')).toBe(0);
    for (let i = 0; i < 12; i += 1) mem.record('p', 'm', 'coding', true, 100);
    expect(mem.scoreAdjustment('p', 'm', 'coding')).toBeGreaterThan(0);
    rmDir(dir);
  });

  it('penalizes consistently failing models', () => {
    const dir = tmpDir();
    const mem = new PerformanceMemory(dir);
    for (let i = 0; i < 12; i += 1) mem.record('p', 'm', 'coding', false, 9000);
    expect(mem.scoreAdjustment('p', 'm', 'coding')).toBeLessThan(0);
    rmDir(dir);
  });

  it('persists across instances', () => {
    const dir = tmpDir();
    const m1 = new PerformanceMemory(dir);
    for (let i = 0; i < 6; i += 1) m1.record('p', 'm', 'vision', true, 300);
    const m2 = new PerformanceMemory(dir);
    expect(m2.scoreAdjustment('p', 'm', 'vision')).toBeGreaterThan(0);
    rmDir(dir);
  });
});
