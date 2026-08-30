/**
 * SERA — ModelOrchestrator: the brain-of-brains facade.
 *
 * Owns the full pipeline for every AI request:
 *   classify -> route (free-first, privacy-aware) -> execute via adapter
 *   -> on failure: classify + fall through the ranked shortlist
 *   -> record telemetry, health, performance, cost.
 *
 * It layers ON TOP of the existing SERA brain stack (LocalAgentEngine for
 * tool loops, Gemini Live for realtime voice) — it does not replace them.
 * Its sweet spots: text generation, per-subtask model selection, vision
 * descriptions, planning, and any request that benefits from picking the
 * right brain per task.
 */
import { randomUUID } from 'node:crypto';
import { ProviderRegistry } from './ProviderRegistry';
import { ProviderHealthMonitor } from './ProviderHealthMonitor';
import { CostController } from './CostController';
import { PerformanceMemory } from './PerformanceMemory';
import { ModelRouter } from './ModelRouter';
import { classifyFailure, describeFailure, recoveryStrategy } from './FallbackManager';
import { createAdapterFor, OllamaAdapter } from './adapters';
import { defaultApiKeyVault, type ApiProvider } from '../local/ApiKeyVault';
import { defaultHardwareInspector } from '../local/HardwareInspector';
import { recommendLocalModel } from '../local/ModelRecommender';
import { defaultOllamaClient } from '../local/OllamaClient';
import { ProviderError } from './types';
import { stateDir } from '../local/SERAPaths';
import type {
  AdapterChatRequest,
  AdapterChatReply,
  ModelAudit,
  ModelDescriptor,
  PrivacyLevel,
  ProviderAdapter,
  ProviderDescriptor,
  RoutingContext,
  RoutingDecision,
  RoutingMode,
  TaskCategory,
  TelemetryEvent,
} from './types';

const MAX_FALLBACKS = 4;

export interface OrchestratorRequest {
  text: string;
  sessionId?: string;
  /** Force a task category (otherwise auto-classified). */
  taskType?: TaskCategory;
  /** Force a privacy level (otherwise auto-classified). */
  privacy?: PrivacyLevel;
  requires?: RoutingContext['requires'];
  images?: string[];
  /** True when the request carries images (needs a vision-capable model). */
  hasImages?: boolean;
  system?: string;
  history?: AdapterChatRequest['messages'];
  temperature?: number;
  maxTokens?: number;
}

export interface OrchestratorResult {
  requestId: string;
  ok: boolean;
  text: string;
  decision: RoutingDecision;
  /** The chain the orchestrator walked: [{model, reason}] for successes/failures. */
  attempts: Array<{ providerId: string; modelId: string; ok: boolean; reason?: string; latencyMs: number }>;
  telemetry: TelemetryEvent;
  explanation: string;
  error?: string;
}

export interface OrchestratorStatus {
  routingMode: RoutingMode;
  providers: Array<{
    id: string;
    name: string;
    type: ProviderDescriptor['type'];
    enabled: boolean;
    priority: number;
    freeTier: ProviderDescriptor['freeTier'];
    trustedForPrivate: boolean;
    hasKey: boolean;
    health: ReturnType<ProviderHealthMonitor['snapshot']>;
    notes?: string;
    models: Array<ModelDescriptor & { scoreHint: number }>;
  }>;
  cost: ReturnType<CostController['summary']>;
  telemetry: TelemetryEvent[];
}

export class ModelOrchestrator {
  readonly registry: ProviderRegistry;
  readonly health = new ProviderHealthMonitor();
  readonly cost: CostController;
  readonly performance: PerformanceMemory;
  private readonly router: ModelRouter;
  private adapters = new Map<string, ProviderAdapter>();
  private telemetryLog: TelemetryEvent[] = [];
  private readonly resolveKey: (keyProviderId: string) => string | null;

  constructor(
    dataDir: string = stateDir(),
    private readonly ollamaAdapter: ProviderAdapter = new OllamaAdapter(),
    options?: { credentialResolver?: (keyProviderId: string) => string | null },
  ) {
    this.registry = new ProviderRegistry(dataDir);
    this.cost = new CostController(dataDir);
    this.performance = new PerformanceMemory(dataDir);
    // Credential resolution is injectable so tests can run fully hermetic;
    // production resolves env-var-first through the encrypted vault.
    this.resolveKey = options?.credentialResolver ?? ((id: string) => defaultApiKeyVault.resolveKey(id as ApiProvider));
    this.router = new ModelRouter({
      health: this.health,
      cost: this.cost,
      performance: this.performance,
      hasCredential: (provider) => {
        if (provider.type === 'local') return true; // credential-less by design
        return Boolean(provider.keyProviderId && this.resolveKey(provider.keyProviderId));
      },
    });
  }

  /* -- routing (no execution) -------------------------------------------------- */
  routeOnly(request: OrchestratorRequest): RoutingDecision {
    const providers = this.registry.list();
    return this.router.route(
      {
        text: request.text,
        taskType: request.taskType,
        privacy: request.privacy,
        requires: request.requires,
        hasImages: Boolean(request.images?.length) || request.hasImages,
      },
      providers,
      this.registry.routingMode,
    );
  }

  /** Full generate with smart fallback. NEVER throws — errors come back structured. */
  async generate(request: OrchestratorRequest): Promise<OrchestratorResult> {
    const decision = this.routeOnly(request);
    const attempts: OrchestratorResult['attempts'] = [];
    const totalStart = Date.now();

    // Build the fallback chain as the best candidate PER PROVIDER (in router
    // rank order). One dead provider must never consume multiple fallback
    // slots — a retry of its sibling model is nearly always the same outage.
    // Exception: model_unavailable failures may retry the same provider's
    // next model (the provider itself is healthy).
    const seenProviders = new Set<string>();
    const shortlist: typeof decision.candidates = [];
    for (const c of decision.candidates) {
      if (seenProviders.has(c.providerId)) continue;
      seenProviders.add(c.providerId);
      shortlist.push(c);
      if (shortlist.length >= MAX_FALLBACKS) break;
    }
    const triedSignatures = new Set<string>(shortlist.map((c) => `${c.providerId}:${c.modelId}`));

    let lastError: string | undefined;
    let lastKind: string | undefined;

    for (let i = 0; i < shortlist.length; i += 1) {
      const candidate = shortlist[i];
      const provider = this.registry.get(candidate.providerId);
      if (!provider) continue;

      // Dynamic gate re-check: a failure earlier in the chain may have changed
      // health (e.g. rate limit cooled / offline) — don't send into a dead end.
      if (i > 0 && !this.health.isUsable(provider.id)) {
        const snap = this.health.snapshot(provider.id);
        attempts.push({ providerId: provider.id, modelId: candidate.modelId, ok: false, reason: `health: ${snap.state}`, latencyMs: 0 });
        continue;
      }

      const adapter = this.adapterFor(provider);
      if (!adapter) {
        attempts.push({ providerId: provider.id, modelId: candidate.modelId, ok: false, reason: 'no adapter', latencyMs: 0 });
        shortlist.splice(i, 1);
        i -= 1;
        continue;
      }

      const started = Date.now();
      try {
        const reply = await adapter.chat(
          {
            model: candidate.modelId,
            system: request.system,
            messages: request.history?.length ? [...request.history, { role: 'user' as const, content: request.text }] : [{ role: 'user' as const, content: request.text }],
            temperature: request.temperature,
            maxTokens: request.maxTokens,
            images: request.images,
          },
          this.healthTimeoutFor(provider),
        );
        const latencyMs = Date.now() - started;
        this.health.recordSuccess(provider.id, latencyMs);
        this.performance.record(provider.id, candidate.modelId, decision.taskType, true, latencyMs);
        const failedBefore = attempts.filter((a) => !a.ok).length;
        const telemetry = this.pushTelemetry({
          requestId: decision.requestId,
          taskType: decision.taskType,
          providerId: provider.id,
          modelId: candidate.modelId,
          localOrCloud: provider.type === 'local' ? 'local' : 'cloud',
          freeOrPaid: provider.type === 'paid' ? 'paid' : 'free',
          latencyMs,
          ttftMs: reply.ttftMs,
          tokensIn: reply.tokensIn,
          tokensOut: reply.tokensOut,
          success: true,
          fallbackUsed: failedBefore > 0,
          fallbackReason: failedBefore > 0 ? attempts.find((a) => !a.ok)?.reason : undefined,
          at: new Date().toISOString(),
        });
        const costUsd = this.cost.estimateCostUsd(provider.type, candidate.modelId, reply.tokensIn ?? 0, reply.tokensOut ?? 0);
        this.cost.recordSpend(costUsd);
        attempts.push({ providerId: provider.id, modelId: candidate.modelId, ok: true, latencyMs });
        return {
          requestId: decision.requestId,
          ok: true,
          text: reply.text,
          decision,
          attempts,
          telemetry,
          explanation: this.explain(decision, attempts),
        };
      } catch (err) {
        const kind = classifyFailure({ error: err, providerId: provider.id, modelId: candidate.modelId, status: err instanceof ProviderError ? err.status : undefined });
        const latencyMs = Date.now() - started;
        this.health.recordFailure(provider.id, kind);
        this.performance.record(provider.id, candidate.modelId, decision.taskType, false, latencyMs);
        attempts.push({ providerId: provider.id, modelId: candidate.modelId, ok: false, reason: `${kind}: ${describeFailure(kind)}`, latencyMs });
        lastError = err instanceof Error ? err.message : String(err);
        lastKind = kind;

        // CRITICAL: drop the failed candidate BEFORE re-arranging the chain,
        // otherwise preferLocalNext can float it back to the front and we
        // would burn remaining fallback slots retrying the same dead end.
        shortlist.splice(i, 1);
        i -= 1;

        const strategy = recoveryStrategy(kind);

        // model_unavailable = the provider is alive but THIS model is not:
        // inject its next-best model into the chain at the current position.
        if (strategy.retrySameProvider) {
          const nextModel = decision.candidates.find(
            (c) => c.providerId === provider.id && !triedSignatures.has(`${c.providerId}:${c.modelId}`),
          );
          if (nextModel) {
            triedSignatures.add(`${nextModel.providerId}:${nextModel.modelId}`);
            shortlist.splice(i + 1, 0, nextModel);
          }
        }

        if (strategy.needsBiggerContext || strategy.needsVision) {
          // Drop candidates that would repeat the same hard failure.
          for (let j = 0; j < shortlist.length; j += 1) {
            const c = shortlist[j];
            const p = this.registry.get(c.providerId);
            const m = p?.models.find((mm) => mm.id === c.modelId);
            const failedWindow = provider.models.find((mm) => mm.id === candidate.modelId)?.contextWindow ?? 0;
            if (strategy.needsBiggerContext && m && m.contextWindow <= failedWindow) {
              shortlist.splice(j, 1);
              j -= 1;
              continue;
            }
            if (strategy.needsVision && m && m.caps.vision <= 0) {
              shortlist.splice(j, 1);
              j -= 1;
            }
          }
        }
        if (strategy.preferLocalNext) {
          shortlist.sort((a, b) => {
            const aLocal = a.providerType === 'local' ? 0 : 1;
            const bLocal = b.providerType === 'local' ? 0 : 1;
            return aLocal - bLocal;
          });
        }
      }
    }

    // Everything failed — return an honest structured failure.
    const firstProvider = shortlist[0] ? this.registry.get(shortlist[0].providerId) : null;
    const telemetry = this.pushTelemetry({
      requestId: decision.requestId,
      taskType: decision.taskType,
      providerId: shortlist[0]?.providerId ?? 'none',
      modelId: shortlist[0]?.modelId ?? 'none',
      localOrCloud: firstProvider?.type === 'local' ? 'local' : 'cloud',
      freeOrPaid: firstProvider?.type === 'paid' ? 'paid' : 'free',
      latencyMs: Date.now() - totalStart,
      success: false,
      fallbackUsed: attempts.length > 1,
      fallbackReason: lastKind,
      failureKind: (lastKind as TelemetryEvent['failureKind']) ?? 'unknown',
      at: new Date().toISOString(),
    });
    return {
      requestId: decision.requestId,
      ok: false,
      text: '',
      decision,
      attempts,
      telemetry,
      explanation: this.explain(decision, attempts),
      error: lastError ?? 'all providers failed',
    };
  }

  /* -- explainability ----------------------------------------------------------- */
  explain(decision: RoutingDecision, attempts?: OrchestratorResult['attempts']): string {
    let base: string = decision.rationale;
    if (attempts && attempts.length > 0) {
      const chain = attempts.map((a) => `${a.modelId} ${a.ok ? 'OK' : `failed (${a.reason ?? '?'})`}`).join(' -> ');
      const lastFailed = !attempts.at(-1)!.ok;
      if (lastFailed) {
        base = `All available options failed for this request. Chain: ${chain}. ${base}`;
      } else {
        base += ` Fallback chain: ${chain}.`;
      }
    }
    return base;
  }

  /* -- status / settings ---------------------------------------------------------- */
  status(): OrchestratorStatus {
    const providers = this.registry.list().map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      enabled: p.enabled,
      priority: p.priority,
      freeTier: p.freeTier,
      trustedForPrivate: p.trustedForPrivate,
      hasKey: p.type === 'local' ? true : Boolean(p.keyProviderId && this.resolveKey(p.keyProviderId)),
      health: this.health.snapshot(p.id),
      notes: p.notes,
      models: p.models.map((m) => ({ ...m, scoreHint: 0 })),
    }));
    return {
      routingMode: this.registry.routingMode,
      providers,
      cost: this.cost.summary(),
      telemetry: this.telemetryLog.slice(-50).reverse(),
    };
  }

  setRoutingMode(mode: RoutingMode): void {
    this.registry.setRoutingMode(mode);
  }

  setProviderEnabled(id: string, enabled: boolean): boolean {
    // Enabling a PAID provider also requires the global paid switch — but we
    // record the per-provider authorization either way (it can be pre-armed).
    return this.registry.setEnabled(id, enabled);
  }

  setProviderPriority(id: string, priority: number): boolean {
    return this.registry.setPriority(id, priority);
  }

  setProviderTrustedForPrivate(id: string, trusted: boolean): boolean {
    return this.registry.setTrustedForPrivate(id, trusted);
  }

  async testProvider(id: string): Promise<{ ok: boolean; state: string; message: string; latencyMs?: number }> {
    const provider = this.registry.get(id);
    if (!provider) return { ok: false, state: 'unavailable', message: 'unknown provider' };
    const adapter = this.adapterFor(provider);
    if (!adapter) return { ok: false, state: 'unavailable', message: 'no adapter for endpoint' };
    const result = await adapter.probe();
    this.health.setState(id, result.state);
    return result;
  }

  /* -- startup model audit (spec: STARTUP MODEL AUDIT) ------------------------------ */
  async audit(): Promise<ModelAudit> {
    const hardware = await defaultHardwareInspector.audit();
    const recommendation = recommendLocalModel(hardware);
    const ollamaStatus = await defaultOllamaClient.status().catch(() => null);
    const installed = ollamaStatus?.running ? await defaultOllamaClient.listModels().catch(() => []) : [];
    const localProviders = this.registry.get('ollama');
    const installedNames = installed.map((m) => m.name);
    const localAvailable = (prefix: string) => installedNames.some((n) => n.startsWith(prefix.split(':')[0]));

    const primary = recommendation.model;
    const catalog = localProviders?.models ?? [];
    const fastest = [...catalog].sort((a, b) => b.caps.fast_response - a.caps.fast_response)[0];
    const deepest = [...catalog].sort((a, b) => b.caps.reasoning + b.caps.coding - (a.caps.reasoning + a.caps.coding))[0];
    const recommendations: string[] = [];

    // v1.6.11 FIX: `localAvailable(primary) ? primary : primary` was a no-op
    // — both branches identical (the intended fallback was lost in a
    // refactor). When the recommended primary is NOT installed, the audit
    // now honestly falls back to the fastest INSTALLED local model, and to
    // the emergency fallback when nothing is installed at all.
    let primaryLocalModel = primary;
    if (!localAvailable(primary)) {
      const firstInstalled = catalog.find((m) => installedNames.some((n) => n.startsWith(m.id.split(':')[0])));
      primaryLocalModel = firstInstalled?.id ?? 'qwen2.5:1.5b-instruct-q4_K_M';
      recommendations.push(
        `Recommended model "${primary}" is not installed yet — audit falls back to "${primaryLocalModel}" until you pull it.`,
      );
    }

    return {
      hardwareTier: hardware.tier,
      primaryLocalModel,
      fastVoiceModel: fastest?.id ?? null,
      reasoningModel: deepest?.id ?? null,
      visionModel: null, // local vision arrives via inspectScreen OCR + future local VLMs
      emergencyFallback: 'qwen2.5:1.5b-instruct-q4_K_M',
      ollamaRunning: Boolean(ollamaStatus?.running),
      installedModels: installedNames,
      recommendations,
    };
  }

  /* -- internals ------------------------------------------------------------------ */
  private adapterFor(provider: ProviderDescriptor): ProviderAdapter | null {
    if (provider.type === 'local') return this.ollamaAdapter;
    const cached = this.adapters.get(provider.id);
    if (cached) return cached;
    const created = createAdapterFor(provider);
    if (created) this.adapters.set(provider.id, created);
    return created;
  }

  /** Timeouts: voice-speed requests fail over fast; heavy reasoning waits. */
  private healthTimeoutFor(provider: ProviderDescriptor): number {
    if (provider.type === 'local') return 120_000;
    return this.registry.routingMode === 'performance_first' ? 90_000 : 45_000;
  }

  private pushTelemetry(event: TelemetryEvent): TelemetryEvent {
    this.telemetryLog.push(event);
    if (this.telemetryLog.length > 200) this.telemetryLog.shift();
    return event;
  }
}

/** Process-wide orchestrator singleton. */
export const defaultModelOrchestrator = new ModelOrchestrator();
