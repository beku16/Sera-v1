/**
 * SERA — ProviderHealthMonitor.
 *
 * Tracks per-provider health so the router never sends requests to a known
 * dead/broken provider (spec: PROVIDER HEALTH MONITOR). States:
 * healthy | degraded | rate_limited | offline | invalid_key | unavailable | unknown
 *
 * Behavior rules:
 *  - AUTH_FAILURE   -> invalid_key until the user re-tests the key.
 *  - RATE_LIMIT     -> rate_limited with a cooldown window, auto-recovers.
 *  - NETWORK/OFFLINE-> offline with a shorter cooldown (networks heal).
 *  - Success        -> healthy again, EMA latency updated.
 */
import type { FailureKind, HealthState } from './types';

export interface ProviderHealthSnapshot {
  state: HealthState;
  /** EWMA latency of successful requests (ms). */
  avgLatencyMs: number;
  successRate: number; // 0..1 over the recent window
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureKind: FailureKind | null;
  rateLimitEvents: number;
  consecutiveFailures: number;
  /** Epoch ms when a rate-limit/offline cooldown ends (0 = none). */
  cooldownUntil: number;
}

const RECENT_WINDOW = 20;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const OFFLINE_COOLDOWN_MS = 30_000;
const DEGRADED_LATENCY_MS = 8000;

export class ProviderHealthMonitor {
  private state = new Map<string, ProviderHealthSnapshot>();
  private outcomes = new Map<string, boolean[]>();

  snapshot(providerId: string): ProviderHealthSnapshot {
    let s = this.state.get(providerId);
    if (!s) {
      s = {
        state: 'unknown',
        avgLatencyMs: 0,
        successRate: 1,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureKind: null,
        rateLimitEvents: 0,
        consecutiveFailures: 0,
        cooldownUntil: 0,
      };
      this.state.set(providerId, s);
    }
    // Auto-recover from cooldown-based states once the window has passed.
    if ((s.state === 'rate_limited' || s.state === 'offline') && s.cooldownUntil > 0 && Date.now() >= s.cooldownUntil) {
      s.state = 'degraded';
      s.cooldownUntil = 0;
    }
    return s;
  }

  recordSuccess(providerId: string, latencyMs: number): void {
    const s = this.snapshot(providerId);
    s.state = latencyMs > DEGRADED_LATENCY_MS ? 'degraded' : 'healthy';
    s.avgLatencyMs = s.avgLatencyMs === 0 ? latencyMs : Math.round(s.avgLatencyMs * 0.7 + latencyMs * 0.3);
    s.lastSuccessAt = new Date().toISOString();
    s.consecutiveFailures = 0;
    s.cooldownUntil = 0;
    this.pushOutcome(providerId, true);
  }

  recordFailure(providerId: string, kind: FailureKind): void {
    const s = this.snapshot(providerId);
    s.lastFailureAt = new Date().toISOString();
    s.lastFailureKind = kind;
    s.consecutiveFailures += 1;
    this.pushOutcome(providerId, false);

    switch (kind) {
      case 'auth_failure':
        // Never hammer a dead key — needs explicit user re-test.
        s.state = 'invalid_key';
        s.cooldownUntil = 0;
        break;
      case 'rate_limit':
        s.state = 'rate_limited';
        s.rateLimitEvents += 1;
        s.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        break;
      case 'network_failure':
      case 'provider_offline':
        s.state = 'offline';
        s.cooldownUntil = Date.now() + OFFLINE_COOLDOWN_MS;
        break;
      case 'timeout':
        s.state = s.consecutiveFailures >= 2 ? 'offline' : 'degraded';
        if (s.state === 'offline') s.cooldownUntil = Date.now() + OFFLINE_COOLDOWN_MS;
        break;
      case 'model_unavailable':
      case 'server_error':
        s.state = 'degraded';
        s.cooldownUntil = 0;
        break;
      case 'context_too_large':
      case 'invalid_request':
      case 'vision_unavailable':
      case 'tool_call_failure':
        // Provider is alive; the request was the problem.
        s.state = s.state === 'unknown' ? 'healthy' : s.state;
        break;
      default:
        s.state = 'degraded';
    }
  }

  /** External state override (e.g. a manual probe proved the key valid). */
  setState(providerId: string, healthState: HealthState): void {
    const s = this.snapshot(providerId);
    s.state = healthState;
    s.cooldownUntil = 0;
  }

  /**
   * Can the router currently TRY this provider?
   * unknown counts as usable (never tried); invalid_key/offline-in-cooldown/
   * rate_limited-in-cooldown/unavailable do not.
   */
  isUsable(providerId: string): boolean {
    const s = this.snapshot(providerId);
    if (s.state === 'invalid_key' || s.state === 'unavailable') return false;
    if (s.state === 'rate_limited' && Date.now() < s.cooldownUntil) return false;
    if (s.state === 'offline' && Date.now() < s.cooldownUntil) return false;
    if (s.state === 'offline' && s.cooldownUntil === 0) return false;
    return true;
  }

  private pushOutcome(providerId: string, success: boolean): void {
    let arr = this.outcomes.get(providerId);
    if (!arr) {
      arr = [];
      this.outcomes.set(providerId, arr);
    }
    arr.push(success);
    if (arr.length > RECENT_WINDOW) arr.shift();
    const s = this.state.get(providerId);
    if (s) s.successRate = arr.filter(Boolean).length / arr.length;
  }

  all(): Record<string, ProviderHealthSnapshot> {
    const out: Record<string, ProviderHealthSnapshot> = {};
    for (const id of this.state.keys()) out[id] = { ...this.snapshot(id) };
    return out;
  }
}
