/**
 * SERA — PerformanceMemory: historical per-model performance.
 *
 * Remembers how each model performed per task type (success rate + EWMA
 * latency) and nudges future routing scores accordingly (spec: MODEL
 * PERFORMANCE MEMORY). Guardrails: small samples cannot dominate routing,
 * and a single bad day cannot permanently bury a model (decayed window).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PerformanceStat, TaskCategory } from './types';
import { stateDir } from '../local/SERAPaths';

const MAX_ENTRIES = 400;

/** Router may add up to this bonus/penalty from history (score points). */
export const MAX_HISTORY_BONUS = 8;

export class PerformanceMemory {
  private stats: PerformanceStat[] = [];
  private readonly file: string;

  constructor(dataDir: string = stateDir()) {
    this.file = path.join(dataDir, 'sera_model_performance.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PerformanceStat[];
        if (Array.isArray(raw)) this.stats = raw.slice(0, MAX_ENTRIES);
      }
    } catch {
      this.stats = [];
    }
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.stats, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* best-effort */
    }
  }

  record(providerId: string, modelId: string, taskType: TaskCategory, success: boolean, latencyMs: number): void {
    let stat = this.stats.find((s) => s.providerId === providerId && s.modelId === modelId && s.taskType === taskType);
    if (!stat) {
      stat = { providerId, modelId, taskType, successes: 0, failures: 0, avgLatencyMs: 0, lastUsedAt: '' };
      this.stats.push(stat);
      if (this.stats.length > MAX_ENTRIES) this.stats.shift();
    }
    if (success) stat.successes += 1;
    else stat.failures += 1;
    stat.avgLatencyMs =
      stat.avgLatencyMs === 0 ? Math.round(latencyMs) : Math.round(stat.avgLatencyMs * 0.7 + latencyMs * 0.3);
    stat.lastUsedAt = new Date().toISOString();
    this.save();
  }

  private statFor(providerId: string, modelId: string, taskType: TaskCategory): PerformanceStat | null {
    return this.stats.find((s) => s.providerId === providerId && s.modelId === modelId && s.taskType === taskType) ?? null;
  }

  /**
   * Score adjustment in [-MAX_HISTORY_BONUS, +MAX_HISTORY_BONUS].
   * Requires >= 3 samples before it says anything (noise guard), and scales
   * smoothly with sample size so early data can't dominate.
   */
  scoreAdjustment(providerId: string, modelId: string, taskType: TaskCategory): number {
    const stat = this.statFor(providerId, modelId, taskType);
    if (!stat) return 0;
    const total = stat.successes + stat.failures;
    if (total < 3) return 0;
    const successRate = stat.successes / total;
    const confidence = Math.min(1, (total - 2) / 10); // full weight at 12 samples
    const rateBonus = (successRate - 0.75) * 20; // +5 at 100%, -5 at 50%, -15 at 0%
    const speedBonus = stat.avgLatencyMs > 0 && stat.avgLatencyMs < 1500 ? 2 : stat.avgLatencyMs > 12000 ? -2 : 0;
    return Math.max(-MAX_HISTORY_BONUS, Math.min(MAX_HISTORY_BONUS, (rateBonus + speedBonus) * confidence));
  }

  all(): PerformanceStat[] {
    return [...this.stats];
  }
}
