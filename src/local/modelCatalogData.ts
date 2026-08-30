import type { HardwareReport } from './HardwareInspector';

/**
 * modelCatalogData.ts — the single source of truth for every local model
 * SERA knows how to install (v1.9.0).
 *
 * Split out of ModelRecommender so the DATA (catalog) and the POLICY
 * (recommendation) can evolve independently: the wizard, the MY PC tab and
 * /api/local/catalog all render this catalog, while the recommender only
 * picks from it.
 *
 * ── Honest data policy ─────────────────────────────────────────────
 * Every `id` below was verified LIVE against https://ollama.com/library/<id>
 * before being added (sizes are the registry's own default-tag download
 * sizes at q4_K_M). `estVramMB` includes KV-cache headroom at the listed
 * context. If you add a model, verify the tag resolves on the registry —
 * a dead tag turns into a guaranteed pull failure for every user.
 *
 * ── minTier is a MINIMUM, not a whitelist ───────────────────────────
 * `minTier` names the WEAKEST hardware tier the model is usable on; every
 * stronger tier also qualifies (tierRank(tier) >= tierRank(minTier)). The
 * old exact-membership filter made lighter models invisible on stronger
 * GPUs (phi3.5 was unreachable on cuda-high, qwen2.5:1.5b on nothing but
 * cuda-low) — see BUG L1 in the PHASE 0 audit.
 *
 * ── Why llama3.3 is NOT in the catalog ──────────────────────────────
 * llama3.3 ships only as a 70B (~43 GB download). Recommending it for the
 * 4–8 GB GPUs SERA targets would be dishonest; it would land as
 * "Not-Recommended" on every supported tier. Users with hardware that big
 * can still pull any tag through Ollama directly.
 */

export type ModelProvider = 'qwen' | 'llama' | 'phi' | 'gemma';
export type ToolSupportClass = 'native' | 'basic' | 'limited';
export type CapabilityLevel = 'high' | 'medium' | 'light';
export type CpuFallbackSpeed = 'usable' | 'moderate' | 'slow';
export type CompatibilityClass = 'universal' | 'ollama-0.5+';

export interface LocalModelSpec {
  /** Pullable Ollama tag — must resolve on https://ollama.com/library/<id>. */
  id: string;
  label: string;
  provider: ModelProvider;
  /** Parameter size, e.g. "7B" — the main quality/speed dial. */
  params: string;
  /** Approximate VRAM needed at the recommended context, in MB. */
  estVramMB: number;
  /** Size of the download in MB (approximate, from the registry page). */
  downloadMB: number;
  contextWindow: number;
  /** Qualitative speed class used by the wizard UI. */
  speedClass: 'lightning' | 'fast' | 'balanced';
  /** What this model is best at. */
  strengths: string;
  /** WEAKEST tier this model is usable on — stronger tiers also qualify. */
  minTier: HardwareReport['tier'];
  /** CPU fallback acceptable? (slower but works without VRAM) */
  cpuFallback: boolean;
  /** How painful the CPU fallback is, honestly. */
  cpuFallbackSpeed: CpuFallbackSpeed;
  /** Native Ollama tool-call support (SERA's agent loop depends on this). */
  toolSupport: ToolSupportClass;
  /** Can consume images (screen frames) through Ollama vision. */
  vision: boolean;
  reasoning: CapabilityLevel;
  coding: CapabilityLevel;
  /** Minimum Ollama generation the tag requires. */
  compatibility: CompatibilityClass;
  /** One-line honest note shown in the picker. */
  notes: string;
  /**
   * Preference weight among models that fit: higher wins, ties broken by
   * larger estVramMB. Encodes the documented spec policy (7B precision
   * first on big GPUs, llama3.2:3b as the designated speed model, …).
   */
  rank: number;
  /** SERA version this entry was added/verified in (provenance). */
  addedIn: string;
}

export const LOCAL_MODEL_CATALOG: LocalModelSpec[] = [
  {
    id: 'qwen2.5:7b-instruct-q4_K_M',
    label: 'Qwen 2.5 7B Instruct (Q4_K_M)',
    provider: 'qwen',
    params: '7B',
    estVramMB: 5400,
    downloadMB: 4700,
    contextWindow: 32768,
    speedClass: 'balanced',
    strengths: 'High-precision reasoning, coding, structured tool calls — the smart choice.',
    minTier: 'cuda-mid',
    cpuFallback: true,
    cpuFallbackSpeed: 'slow',
    toolSupport: 'native',
    vision: false,
    reasoning: 'high',
    coding: 'high',
    compatibility: 'universal',
    notes: 'Best quality that still fits consumer GPUs; needs ~5.3 GB free VRAM.',
    rank: 100,
    addedIn: '1.6.7',
  },
  {
    id: 'qwen3:8b',
    label: 'Qwen 3 8B (Q4_K_M)',
    provider: 'qwen',
    params: '8B',
    estVramMB: 5800,
    downloadMB: 5300,
    contextWindow: 32768,
    speedClass: 'balanced',
    strengths: 'Newest generation — native tool calls, hybrid thinking mode, strong multilingual skills.',
    minTier: 'cuda-high',
    cpuFallback: true,
    cpuFallbackSpeed: 'slow',
    toolSupport: 'native',
    vision: false,
    reasoning: 'high',
    coding: 'high',
    compatibility: 'ollama-0.5+',
    notes: 'Verified live on the Ollama registry (2.5/5.2 GB downloads). Needs a 6 GB+ GPU.',
    rank: 92,
    addedIn: '1.9.0',
  },
  {
    id: 'llama3.2:3b-instruct-q4_K_M',
    label: 'Llama 3.2 3B Instruct (Q4_K_M)',
    provider: 'llama',
    params: '3B',
    estVramMB: 2600,
    downloadMB: 2000,
    contextWindow: 131072,
    speedClass: 'lightning',
    strengths: 'Lightning-fast voice conversation with solid tool-calling.',
    minTier: 'cuda-low',
    cpuFallback: true,
    cpuFallbackSpeed: 'moderate',
    toolSupport: 'native',
    vision: false,
    reasoning: 'medium',
    coding: 'light',
    compatibility: 'universal',
    notes: 'The designated speed model — near-instant replies on any CUDA GPU.',
    rank: 84,
    addedIn: '1.6.7',
  },
  {
    id: 'gemma3:4b',
    label: 'Gemma 3 4B (Q4_K_M)',
    provider: 'gemma',
    params: '4B',
    estVramMB: 3500,
    downloadMB: 3400,
    contextWindow: 131072,
    speedClass: 'fast',
    strengths: 'Vision-capable — can actually look at images — with a huge 128K context.',
    minTier: 'cuda-low',
    cpuFallback: true,
    cpuFallbackSpeed: 'moderate',
    toolSupport: 'basic',
    vision: true,
    reasoning: 'medium',
    coding: 'medium',
    compatibility: 'ollama-0.5+',
    notes: 'Verified live on the Ollama registry (3.3 GB download). The only catalog model with vision.',
    rank: 80,
    addedIn: '1.9.0',
  },
  {
    id: 'qwen3:4b',
    label: 'Qwen 3 4B (Q4_K_M)',
    provider: 'qwen',
    params: '4B',
    estVramMB: 3200,
    downloadMB: 2600,
    contextWindow: 32768,
    speedClass: 'fast',
    strengths: 'Modern reasoning with native tool calls at mid size — great quality/speed balance.',
    minTier: 'cuda-low',
    cpuFallback: true,
    cpuFallbackSpeed: 'moderate',
    toolSupport: 'native',
    vision: false,
    reasoning: 'medium',
    coding: 'medium',
    compatibility: 'ollama-0.5+',
    notes: 'Verified live on the Ollama registry (2.5 GB download).',
    rank: 78,
    addedIn: '1.9.0',
  },
  {
    id: 'phi3.5:3.8b-mini-instruct-q4_K_M',
    label: 'Phi 3.5 Mini Instruct (Q4_K_M)',
    provider: 'phi',
    params: '3.8B',
    estVramMB: 2900,
    downloadMB: 2300,
    contextWindow: 131072,
    speedClass: 'fast',
    strengths: 'Efficient general assistant with strong instruction following.',
    minTier: 'cuda-low',
    cpuFallback: true,
    cpuFallbackSpeed: 'moderate',
    toolSupport: 'basic',
    vision: false,
    reasoning: 'medium',
    coding: 'medium',
    compatibility: 'universal',
    notes: 'Solid all-rounder; now visible on EVERY CUDA tier (was hidden on big GPUs — BUG L1).',
    rank: 70,
    addedIn: '1.6.7',
  },
  {
    id: 'qwen2.5:1.5b-instruct-q4_K_M',
    label: 'Qwen 2.5 1.5B Instruct (Q4_K_M)',
    provider: 'qwen',
    params: '1.5B',
    estVramMB: 1400,
    downloadMB: 1000,
    contextWindow: 32768,
    speedClass: 'lightning',
    strengths: 'Ultra-light fallback for very constrained machines.',
    minTier: 'cuda-low',
    cpuFallback: true,
    cpuFallbackSpeed: 'usable',
    toolSupport: 'basic',
    vision: false,
    reasoning: 'light',
    coding: 'light',
    compatibility: 'universal',
    notes: 'The only model whose CPU fallback is genuinely usable for voice.',
    rank: 40,
    addedIn: '1.6.7',
  },
];

/** Ordered weakest → strongest. Drives the minTier >= comparison. */
export const TIER_ORDER: Array<HardwareReport['tier']> = ['cpu-only', 'cuda-low', 'cuda-mid', 'cuda-high'];

export function tierRank(tier: HardwareReport['tier']): number {
  return TIER_ORDER.indexOf(tier);
}

/** True when `tier` is at least as strong as the model's minimum tier. */
export function meetsMinimumTier(tier: HardwareReport['tier'], minTier: HardwareReport['tier']): boolean {
  return tierRank(tier) >= tierRank(minTier);
}
