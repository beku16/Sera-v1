/**
 * SERA — CostController.
 *
 * The free-first money guard. Laws (spec: MOST IMPORTANT RULE):
 *  1. PAID = OFF by default. allowPaidProviders persists as FALSE and can
 *     only be flipped by an explicit user action (Settings / API).
 *  2. If paid is disabled, paid providers are NEVER called — not even for
 *     "one tiny fallback". No exceptions.
 *  3. Even when paid is enabled, per-day / per-month budgets cap spending,
 *     and every paid request must be authorized per provider by the user.
 *  4. Every paid request's estimated cost is tracked in a persistent ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CostLedger, ProviderType } from './types';
import { stateDir } from '../local/SERAPaths';

/** Rough $/1k-token price hints for paid models (estimates, upper bound). */
const PAID_PRICE_PER_1K_USD: Record<string, { in: number; out: number }> = {
  'gpt-4o': { in: 0.005, out: 0.015 },
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'deepseek-chat': { in: 0.00027, out: 0.0011 },
};
const FALLBACK_PRICE = { in: 0.005, out: 0.015 };

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export class CostController {
  private ledger: CostLedger;
  private readonly file: string;

  // v1.9.0 (BUG L5): state lives in the per-user SERA data dir, never the
// (possibly read-only) install dir.
constructor(dataDir: string = stateDir()) {
    this.file = path.join(dataDir, 'sera_cost_ledger.json');
    this.ledger = this.load();
  }

  private load(): CostLedger {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<CostLedger>;
        if (typeof raw.allowPaidProviders === 'boolean') {
          return {
            allowPaidProviders: raw.allowPaidProviders,
            dailyBudgetUsd: raw.dailyBudgetUsd ?? null,
            monthlyBudgetUsd: raw.monthlyBudgetUsd ?? null,
            daily: raw.daily ?? {},
            monthly: raw.monthly ?? {},
            updatedAt: raw.updatedAt ?? new Date().toISOString(),
          };
        }
      }
    } catch {
      /* corrupt ledger -> start fresh and safe (paid OFF) */
    }
    return {
      allowPaidProviders: false,
      dailyBudgetUsd: null,
      monthlyBudgetUsd: null,
      daily: {},
      monthly: {},
      updatedAt: new Date().toISOString(),
    };
  }

  private save(): void {
    try {
      this.ledger.updatedAt = new Date().toISOString();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.ledger, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      /* best-effort */
    }
  }

  /** THE gate. Paid may only be used when the user enabled it AND budgets allow. */
  allowsPaid(): boolean {
    if (!this.ledger.allowPaidProviders) return false;
    const daily = this.ledger.daily[todayKey()] ?? 0;
    const monthly = this.ledger.monthly[monthKey()] ?? 0;
    if (this.ledger.dailyBudgetUsd != null && daily >= this.ledger.dailyBudgetUsd) return false;
    if (this.ledger.monthlyBudgetUsd != null && monthly >= this.ledger.monthlyBudgetUsd) return false;
    return true;
  }

  /** The single legal path to turn paid on: an explicit user action. */
  setAllowPaid(enabled: boolean): void {
    this.ledger.allowPaidProviders = Boolean(enabled);
    this.save();
  }

  setBudgets(dailyBudgetUsd: number | null, monthlyBudgetUsd: number | null): void {
    this.ledger.dailyBudgetUsd = dailyBudgetUsd;
    this.ledger.monthlyBudgetUsd = monthlyBudgetUsd;
    this.save();
  }

  estimateCostUsd(providerType: ProviderType, modelId: string, tokensIn: number, tokensOut: number): number {
    if (providerType !== 'paid') return 0;
    const price = PAID_PRICE_PER_1K_USD[modelId] ?? FALLBACK_PRICE;
    return (tokensIn / 1000) * price.in + (tokensOut / 1000) * price.out;
  }

  recordSpend(amountUsd: number): void {
    if (!(amountUsd > 0)) return;
    const d = todayKey();
    const m = monthKey();
    this.ledger.daily[d] = Math.round(((this.ledger.daily[d] ?? 0) + amountUsd) * 1e6) / 1e6;
    this.ledger.monthly[m] = Math.round(((this.ledger.monthly[m] ?? 0) + amountUsd) * 1e6) / 1e6;
    this.save();
  }

  summary(): {
    allowPaidProviders: boolean;
    spentTodayUsd: number;
    spentThisMonthUsd: number;
    dailyBudgetUsd: number | null;
    monthlyBudgetUsd: number | null;
  } {
    return {
      allowPaidProviders: this.ledger.allowPaidProviders,
      spentTodayUsd: this.ledger.daily[todayKey()] ?? 0,
      spentThisMonthUsd: this.ledger.monthly[monthKey()] ?? 0,
      dailyBudgetUsd: this.ledger.dailyBudgetUsd,
      monthlyBudgetUsd: this.ledger.monthlyBudgetUsd,
    };
  }
}
