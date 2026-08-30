/**
 * SERA — ModelRouter: capability-aware, FREE-FIRST model selection.
 *
 * score = capabilityMatch + taskSuitability + latencyScore
 *       + reliabilityScore + availabilityScore + freePriority
 *       + contextFit + historyBonus - costPenalty
 *
 * Hard gates run BEFORE scoring (a model that fails a gate is never chosen):
 *   enabled -> key present -> health usable -> capability requirements met
 *   -> context fits -> privacy policy respected -> paid policy respected.
 *
 * FREE-FIRST is enforced twice: free/local tiers get a large positive bonus,
 * AND paid providers carry a penalty + can be hard-blocked by the
 * CostController (default OFF — see CostController).
 */
import { TaskClassifier } from './TaskClassifier';
import type {
  CapabilityKey,
  HealthState,
  ModelDescriptor,
  ProviderDescriptor,
  RoutingContext,
  RoutingDecision,
  RoutingMode,
  ScoredCandidate,
} from './types';
import type { ProviderHealthMonitor } from './ProviderHealthMonitor';
import type { CostController } from './CostController';
import type { PerformanceMemory } from './PerformanceMemory';

interface ModeWeights {
  localBonus: number;
  freeBonus: number;
  paidPenalty: number;
  latencyWeight: number;
}

const MODE_WEIGHTS: Record<RoutingMode, ModeWeights> = {
  free_first: { localBonus: 45, freeBonus: 28, paidPenalty: 40, latencyWeight: 1 },
  local_first: { localBonus: 70, freeBonus: 12, paidPenalty: 40, latencyWeight: 0.8 },
  balanced: { localBonus: 12, freeBonus: 22, paidPenalty: 30, latencyWeight: 1 },
  performance_first: { localBonus: 6, freeBonus: 8, paidPenalty: 8, latencyWeight: 2 },
  custom: { localBonus: 45, freeBonus: 28, paidPenalty: 40, latencyWeight: 1 },
};

const LATENCY_CLASS_INDEX: Record<ModelDescriptor['latencyClass'], number> = {
  lightning: 0,
  fast: 1,
  moderate: 2,
  slow: 3,
};

export interface RouterDeps {
  health: ProviderHealthMonitor;
  cost: CostController;
  performance: PerformanceMemory;
  /** Returns true when the provider has a usable credential (or needs none). */
  hasCredential(provider: ProviderDescriptor): boolean;
  /** May the provider see PRIVATE content? (Cloud providers: user's call.) */
  privacyProviderFilter?(provider: ProviderDescriptor): boolean;
}

export class ModelRouter {
  private readonly classifier = new TaskClassifier();

  constructor(private readonly deps: RouterDeps) {}

  /** Build the full ranked decision for a request. Never executes anything. */
  route(ctx: RoutingContext, providers: ProviderDescriptor[], routingMode: RoutingMode): RoutingDecision {
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const classification = this.classifier.classify(ctx.text, {
      hasImages: ctx.hasImages,
      requires: ctx.requires,
    });
    const taskType = ctx.taskType ?? classification.taskType;
    const privacy = ctx.privacy ?? classification.privacy;
    const requires = [...new Set([...(ctx.requires ?? []), ...classification.requires])];
    if (ctx.hasImages) requires.push('vision');
    const estimatedTokens = ctx.estimatedTokens ?? classification.estimatedTokens;
    const weights = MODE_WEIGHTS[routingMode] ?? MODE_WEIGHTS.free_first;
    const capWeights = TaskClassifier.taskCapabilityWeights(taskType);

    const candidates: ScoredCandidate[] = [];
    const rejected: RoutingDecision['rejected'] = [];

    for (const provider of providers) {
      for (const model of provider.models) {
        const gate = this.passesGates(provider, model, {
          requires,
          hasImages: Boolean(ctx.hasImages),
          estimatedTokens,
          privacy,
        });
        if (gate) {
          rejected.push({ providerId: provider.id, modelId: model.id, reason: gate });
          continue;
        }
        candidates.push(this.scoreCandidate(provider, model, { taskType, requires, capWeights, estimatedTokens, classificationComplexity: classification.complexity, latencyCritical: classification.latencyCritical }, weights, routingMode));
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    const selected = candidates[0] ?? null;
    const rationale = selected
      ? this.explainSelection(selected, { taskType, privacy, requires, routingMode })
      : this.explainEmpty(rejected, { privacy, requires });

    return {
      requestId,
      taskType,
      privacy,
      requires,
      routingMode,
      selected,
      candidates: candidates.slice(0, 8),
      rejected,
      rationale,
      createdAt: new Date().toISOString(),
    };
  }

  /* -- gates ------------------------------------------------------------------ */
  private passesGates(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    ctx: { requires: CapabilityKey[]; hasImages: boolean; estimatedTokens: number; privacy: RoutingDecision['privacy'] },
  ): string | null {
    if (!provider.enabled) return 'provider disabled';

    if (!this.deps.hasCredential(provider)) return 'no API key configured';

    if (!this.deps.health.isUsable(provider.id)) {
      const snap = this.deps.health.snapshot(provider.id);
      return `provider health: ${snap.state}`;
    }

    for (const cap of ctx.requires) {
      if ((model.caps[cap] ?? 0) <= 0) return `missing capability: ${cap}`;
    }
    if (ctx.hasImages && model.caps.vision <= 0) return 'no vision support';

    const needed = ctx.estimatedTokens + 1024; // leave room for the answer
    if (model.contextWindow > 0 && needed > model.contextWindow) return 'context too large for model';

    if (ctx.privacy === 'highly_private' && provider.type !== 'local') {
      return 'highly private content never leaves the machine';
    }
    if (ctx.privacy === 'private' && provider.type !== 'local' && !provider.trustedForPrivate) {
      return 'private content stays local (provider not marked trusted)';
    }

    if (provider.type === 'paid') {
      if (!this.deps.cost.allowsPaid()) return 'paid providers are locked OFF';
      if (!provider.userAuthorized) return 'paid provider not explicitly authorized';
    }

    // A provider whose terms are unknown is treated like a paid provider.
    if (provider.type === 'free' && provider.freeTier === 'unverified') {
      if (!this.deps.cost.allowsPaid()) return 'free-tier status unverified — treated as paid (locked OFF)';
    }

    return null;
  }

  /* -- scoring ------------------------------------------------------------------ */
  private scoreCandidate(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    ctx: {
      taskType: RoutingDecision['taskType'];
      requires: CapabilityKey[];
      capWeights: Partial<Record<CapabilityKey, number>>;
      estimatedTokens: number;
      classificationComplexity: number;
      latencyCritical: boolean;
    },
    weights: ModeWeights,
    routingMode: RoutingMode,
  ): ScoredCandidate {
    const health = this.deps.health.snapshot(provider.id);

    // 1. Capability match: weighted by what this TASK needs.
    let weightSum = 0;
    let capScore = 0;
    for (const [cap, w] of Object.entries(ctx.capWeights) as Array<[CapabilityKey, number]>) {
      weightSum += w;
      capScore += w * ((model.caps[cap] ?? 0) / 10);
    }
    // Hard requirements the model just barely satisfies shouldn't win on
    // capability alone — but must not be punished for satisfying them.
    for (const req of ctx.requires) {
      if (!ctx.capWeights[req]) {
        weightSum += 0.5;
        capScore += 0.5 * ((model.caps[req] ?? 0) / 10);
      }
    }
    const capabilityMatch = weightSum > 0 ? (capScore / weightSum) * 14 : 7;

    // 2. Task suitability: heavy tasks want deeper models, quick tasks want snappy ones.
    const deepScore = (model.caps.reasoning + model.caps.coding) / 2;
    const quickScore = model.caps.fast_response;
    const taskSuitability =
      ctx.classificationComplexity >= 6 ? (deepScore / 10) * 8 : (quickScore / 10) * 5 + (deepScore / 10) * 3;

    // 3. Latency: catalog class + live measured average.
    const classScore = (3 - LATENCY_CLASS_INDEX[model.latencyClass]) * 2;
    let latencyScore = ctx.latencyCritical ? classScore * weights.latencyWeight * 1.6 : classScore * weights.latencyWeight;
    if (health.avgLatencyMs > 0) {
      // v1.6.11 FIX: the >10000ms branch was dead code — the >4000ms check
      // matched first, so the -3 penalty never applied. Slowest tier first.
      if (health.avgLatencyMs > 10000) latencyScore -= 3;
      else if (health.avgLatencyMs > 4000) latencyScore -= 1.5;
      else if (health.avgLatencyMs < 1200) latencyScore += 2;
    }

    // 4. Reliability from recent outcomes + long-term performance memory.
    const reliabilityScore =
      health.successRate * 4 + (health.consecutiveFailures === 0 ? 1 : 0) + this.deps.performance.scoreAdjustment(provider.id, model.id, ctx.taskType);

    // 5. Availability / health bonus.
    const AVAILABILITY_BONUS: Record<HealthState, number> = {
      healthy: 3,
      degraded: 1.5,
      unknown: 2,
      rate_limited: 0,
      offline: 0,
      invalid_key: 0,
      unavailable: 0,
    };
    const availabilityScore = AVAILABILITY_BONUS[health.state];

    // 6. Free-first tier bonus (the law).
    let freePriority = 0;
    let reasons: string[] = [];
    if (provider.type === 'local') {
      freePriority = weights.localBonus;
    } else if (provider.type === 'free') {
      freePriority = weights.freeBonus;
    }

    // 7. Context fit: more headroom is mildly better.
    const headroom = model.contextWindow > 0 ? 1 - ctx.estimatedTokens / model.contextWindow : 0;
    const contextFit = Math.max(0, Math.min(3, headroom * 3));

    // 8. Cost penalty (paid only; free/local are $0).
    const costPenalty = provider.type === 'paid' ? weights.paidPenalty : 0;

    const score =
      capabilityMatch +
      taskSuitability +
      latencyScore +
      reliabilityScore +
      availabilityScore +
      freePriority +
      contextFit -
      costPenalty;

    reasons = this.buildReasons(provider, model, { taskType: ctx.taskType, routingMode, health, latencyCritical: ctx.latencyCritical });

    return {
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.type,
      modelId: model.id,
      score: Math.round(score * 100) / 100,
      breakdown: {
        capabilityMatch: r2(capabilityMatch),
        taskSuitability: r2(taskSuitability),
        latencyScore: r2(latencyScore),
        reliabilityScore: r2(reliabilityScore),
        availabilityScore: r2(availabilityScore),
        freePriority: r2(freePriority),
        contextFit: r2(contextFit),
        costPenalty: r2(costPenalty),
      },
      health: health.state,
      reasons,
    };
  }

  private buildReasons(
    provider: ProviderDescriptor,
    model: ModelDescriptor,
    ctx: { taskType: RoutingDecision['taskType']; routingMode: RoutingMode; health: { state: HealthState; avgLatencyMs: number }; latencyCritical: boolean },
  ): string[] {
    const reasons: string[] = [];
    if (provider.type === 'local') reasons.push('runs locally — free, private, works offline');
    else if (provider.type === 'free') reasons.push('documented free tier — no cost');
    const strongCaps = (Object.entries(model.caps) as Array<[CapabilityKey, number]>)
      .filter(([, v]) => v >= 8)
      .map(([k]) => k.replace(/_/g, ' '));
    if (strongCaps.length) reasons.push(`strong at ${strongCaps.slice(0, 3).join(', ')}`);
    if (ctx.health.state === 'healthy') {
      reasons.push(ctx.health.avgLatencyMs > 0 ? `healthy, ~${ctx.health.avgLatencyMs} ms recent latency` : 'healthy');
    }
    if (ctx.latencyCritical) reasons.push('voice-speed request — latency weighted heavily');
    const history = this.deps.performance.scoreAdjustment(provider.id, model.id, ctx.taskType);
    if (history >= 4) reasons.push('consistent past success on this task type');
    if (history <= -4) reasons.push('past reliability concerns on this task type');
    return reasons;
  }

  /* -- explainability ------------------------------------------------------------ */
  private explainSelection(
    selected: ScoredCandidate,
    ctx: { taskType: RoutingDecision['taskType']; privacy: RoutingDecision['privacy']; requires: CapabilityKey[]; routingMode: RoutingMode },
  ): string {
    const reqText = ctx.requires.length
      ? `This request needs ${ctx.requires.map((r) => r.replace(/_/g, ' ')).join(' + ')}.`
      : `Classified as ${ctx.taskType.replace(/_/g, ' ')}.`;
    const privacyText =
      ctx.privacy === 'highly_private'
        ? ' Highly private content is processed only on your machine.'
        : ctx.privacy === 'private'
          ? ' Private content prefers local processing.'
          : '';
    return `${reqText} ${selected.modelId} via ${selected.providerName} scored highest (${selected.score}): ${selected.reasons.join('; ')}.${privacyText} Routing mode: ${ctx.routingMode.replace(/_/g, ' ')}.`;
  }

  private explainEmpty(
    rejected: RoutingDecision['rejected'],
    ctx: { privacy: RoutingDecision['privacy']; requires: CapabilityKey[] },
  ): string {
    const top = rejected.slice(0, 4).map((r) => `${r.modelId}: ${r.reason}`).join('; ');
    return (
      'No eligible model right now. ' +
      (ctx.requires.length ? `Required capabilities: ${ctx.requires.join(', ')}. ` : '') +
      (ctx.privacy === 'highly_private' || ctx.privacy === 'private' ? 'Privacy policy is limiting this request to trusted providers. ' : '') +
      (top ? `Why each was skipped — ${top}.` : 'Enable a provider in Settings → Models & Providers (add its free API key), or start Ollama for the local path.')
    );
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
