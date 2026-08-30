import { HardwareReport } from './HardwareInspector';
import {
  LOCAL_MODEL_CATALOG,
  LocalModelSpec,
  meetsMinimumTier,
} from './modelCatalogData';

export { LOCAL_MODEL_CATALOG } from './modelCatalogData';
export type { LocalModelSpec } from './modelCatalogData';
export { tierRank, meetsMinimumTier, TIER_ORDER } from './modelCatalogData';

/**
 * Honest fit categories (spec §91): every recommendation and every catalog
 * row is graded, so the UI never has to guess or oversell.
 *
 *  excellent       — fits in VRAM with ≥25% headroom to spare
 *  good            — fits, but tight (watch what else uses the GPU)
 *  usable          — does NOT fully fit; runs with partial CPU offload
 *                    (slower, still workable when ≥80% of layers fit)
 *  cpu-fallback    — no GPU (or <80% fits) → runs on CPU, honestly slower
 *  not-recommended — does not fit and has no CPU fallback
 */
export type FitCategory = 'excellent' | 'good' | 'usable' | 'cpu-fallback' | 'not-recommended';

export const FIT_LABEL: Record<FitCategory, string> = {
  excellent: 'Excellent fit',
  good: 'Good fit',
  usable: 'Usable — partial CPU offload',
  'cpu-fallback': 'CPU fallback — slower but 100% offline',
  'not-recommended': 'Not recommended for this machine',
};

export function fitCategoryFor(
  spec: LocalModelSpec,
  vramAvailableMB: number,
  hasCuda: boolean,
): FitCategory {
  if (!hasCuda) return spec.cpuFallback ? 'cpu-fallback' : 'not-recommended';
  if (vramAvailableMB >= spec.estVramMB) {
    return vramAvailableMB >= spec.estVramMB * 1.25 ? 'excellent' : 'good';
  }
  if (spec.cpuFallback) {
    // Partial layer offload keeps the GPU doing most of the work when at
    // least ~80% of the model fits — below that it is effectively a CPU run.
    return vramAvailableMB >= spec.estVramMB * 0.8 ? 'usable' : 'cpu-fallback';
  }
  return 'not-recommended';
}

export interface ModelFit {
  category: FitCategory;
  label: string;
  /** MB of VRAM left over when the model is loaded (negative = deficit). */
  headroomMB: number;
}

export interface ModelRecommendation {
  /** The recommended model id (pullable via Ollama). */
  model: string;
  spec: LocalModelSpec;
  /** Human-readable rationale shown in the wizard. */
  rationale: string;
  /** Alternative model if the user prefers speed over precision (or vice versa). */
  alternative?: {
    model: string;
    label: string;
    rationale: string;
  };
  /** Free VRAM required vs available summary for the UI. */
  budget: {
    vramAvailableMB: number;
    vramRequiredMB: number;
    fitsInVram: boolean;
    cpuFallback: boolean;
  };
  /** Honest fit grading for the CHOSEN model (spec §91). */
  fit: ModelFit;
}

/** Candidates visible on this tier (minTier honored as a true minimum). */
function candidatesForTier(tier: HardwareReport['tier']): LocalModelSpec[] {
  return LOCAL_MODEL_CATALOG.filter((spec) => meetsMinimumTier(tier, spec.minTier));
}

/** Preference order for equal-fits: rank desc, then bigger model first. */
function byPreference(a: LocalModelSpec, b: LocalModelSpec): number {
  if (b.rank !== a.rank) return b.rank - a.rank;
  return b.estVramMB - a.estVramMB;
}

/**
 * Recommends the best local model for the audited hardware.
 *
 * Policy (mirrors the SERA master spec, unchanged by the BUG L1 fix):
 *  - cuda-high/cuda-mid with enough free VRAM → `qwen2.5:7b` (precision)
 *    with `llama3.2:3b` offered as the speed-oriented alternative.
 *  - Low VRAM → llama3.2:3b, else qwen2.5:1.5b.
 *  - No CUDA at all → the lightest CPU-fallback model (1.5b) — slower,
 *    still 100% offline.
 *
 * v1.9.0 changes: minTier is now a MINIMUM (lighter models stay visible on
 * stronger GPUs), every result carries an honest fit category, and the
 * rationale explains tools/vision/provider instead of only size.
 */
export function recommendLocalModel(hardware: HardwareReport, preferredFreeVramMB?: number): ModelRecommendation {
  const vramAvailable = preferredFreeVramMB ?? hardware.gpu?.vramFreeMB ?? hardware.gpu?.vramTotalMB ?? 0;
  const hasCuda = Boolean(hardware.gpu?.cudaSupported);

  // BUG L1 FIX: exact-membership filter → true minimum-tier comparison.
  const usable = candidatesForTier(hardware.tier);
  const ordered = [...usable].sort(byPreference);

  let chosen: LocalModelSpec | undefined = ordered.find((spec) => vramAvailable >= spec.estVramMB);
  let fitsInVram = Boolean(chosen);

  if (!chosen) {
    // Either nothing fits in free VRAM, or we're on CPU-only. Take the
    // best-ranked CPU-fallback model (smallest = most usable on CPU).
    const fallbackPool = usable.length ? usable : LOCAL_MODEL_CATALOG;
    chosen =
      fallbackPool.filter((spec) => spec.cpuFallback).sort(byPreference).pop() ||
      LOCAL_MODEL_CATALOG[LOCAL_MODEL_CATALOG.length - 1];
    fitsInVram = hasCuda && vramAvailable >= chosen.estVramMB;
  }

  const alternativeCandidate = usable
    .filter((spec) => spec.id !== chosen.id && spec.estVramMB < chosen.estVramMB)
    .sort(byPreference)[0];

  const fitCategory = fitCategoryFor(chosen, vramAvailable, hasCuda && meetsMinimumTier(hardware.tier, chosen.minTier) && hardware.tier !== 'cpu-only');
  const speedWord = chosen.speedClass === 'lightning' ? 'lightning-fast' : chosen.speedClass === 'fast' ? 'fast' : 'balanced';
  const capabilityBits = [
    chosen.toolSupport === 'native' ? 'native tool calls' : 'basic tool calls',
    chosen.vision ? 'vision (can read your screen frames)' : null,
    chosen.reasoning === 'high' ? 'strong reasoning' : null,
  ].filter(Boolean) as string[];

  const rationale = hasCuda && hardware.tier !== 'cpu-only'
    ? `${hardware.gpu?.name} with ${(vramAvailable / 1024).toFixed(1)} GB usable VRAM → ${chosen.label} runs at ${speedWord} speed with ${Math.round(chosen.contextWindow / 1024)}K context (${FIT_LABEL[fitCategory].toLowerCase()}). Supports ${capabilityBits.join(', ')}. ${chosen.strengths}`
    : `No CUDA GPU detected → ${chosen.label} runs on CPU (${chosen.cpuFallbackSpeed === 'usable' ? 'comfortable' : chosen.cpuFallbackSpeed === 'moderate' ? 'noticeably slower but usable' : 'slow — expect short replies only'}). ${chosen.strengths}`;

  return {
    model: chosen.id,
    spec: chosen,
    rationale,
    alternative: alternativeCandidate
      ? {
          model: alternativeCandidate.id,
          label: alternativeCandidate.label,
          rationale: alternativeCandidate.strengths,
        }
      : undefined,
    budget: {
      vramAvailableMB: vramAvailable,
      vramRequiredMB: chosen.estVramMB,
      fitsInVram,
      cpuFallback: !fitsInVram,
    },
    fit: {
      category: fitCategory,
      label: FIT_LABEL[fitCategory],
      headroomMB: Math.round(vramAvailable - chosen.estVramMB),
    },
  };
}

/**
 * Grades EVERY catalog entry for a hardware report — used by
 * /api/local/catalog so the MY PC picker can badge each model with its
 * honest fit instead of a raw fits/doesn't-fit boolean.
 */
export function gradeCatalog(
  hardware: HardwareReport,
  preferredFreeVramMB?: number,
): Array<LocalModelSpec & { fit: ModelFit; eligible: boolean }> {
  const vramAvailable = preferredFreeVramMB ?? hardware.gpu?.vramFreeMB ?? hardware.gpu?.vramTotalMB ?? 0;
  const hasCuda = Boolean(hardware.gpu?.cudaSupported);
  return LOCAL_MODEL_CATALOG.map((spec) => {
    const eligible = meetsMinimumTier(hardware.tier, spec.minTier) || spec.cpuFallback;
    const category = fitCategoryFor(spec, vramAvailable, hasCuda && meetsMinimumTier(hardware.tier, spec.minTier));
    return {
      ...spec,
      eligible,
      fit: {
        category,
        label: FIT_LABEL[category],
        headroomMB: Math.round(vramAvailable - spec.estVramMB),
      },
    };
  });
}
