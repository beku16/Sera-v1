import { describe, it, expect } from 'vitest';
import {
  recommendLocalModel,
  gradeCatalog,
  fitCategoryFor,
  meetsMinimumTier,
  tierRank,
  LOCAL_MODEL_CATALOG,
  FIT_LABEL,
} from '../local/ModelRecommender';
import type { HardwareReport } from '../local/HardwareInspector';

/**
 * BUG L1 regression matrix: minTier must behave as a MINIMUM tier, not an
 * exact whitelist. Before v1.9.0, `phi3.5` (minTier cuda-mid/cuda-low) was
 * unreachable on cuda-high and `qwen2.5:1.5b` (minTier cuda-low) was
 * invisible everywhere else — lighter models literally did not exist for
 * stronger GPUs.
 */

const report = (overrides: Partial<HardwareReport> = {}): HardwareReport => ({
  platform: 'win32',
  osRelease: '11',
  arch: 'x64',
  hostname: 'test',
  cpu: { model: 'Intel i7', logicalCores: 16, physicalCores: 8, speedGHz: 4.5 },
  ram: { totalMB: 32768, freeMB: 16384 },
  gpu: {
    name: 'NVIDIA GeForce RTX 4050 Laptop GPU',
    vramTotalMB: 6144,
    vramFreeMB: 5412,
    driverVersion: '551.61',
    cudaComputeCapability: '12.4',
    cudaSupported: true,
  },
  tier: 'cuda-high',
  auditedAt: Date.now(),
  probeNotes: [],
  ...overrides,
});

describe('tierRank / meetsMinimumTier', () => {
  it('orders tiers cpu-only < cuda-low < cuda-mid < cuda-high', () => {
    expect(tierRank('cpu-only')).toBeLessThan(tierRank('cuda-low'));
    expect(tierRank('cuda-low')).toBeLessThan(tierRank('cuda-mid'));
    expect(tierRank('cuda-mid')).toBeLessThan(tierRank('cuda-high'));
  });

  it('treats minTier as a floor: stronger tiers qualify', () => {
    expect(meetsMinimumTier('cuda-high', 'cuda-low')).toBe(true);
    expect(meetsMinimumTier('cuda-high', 'cuda-mid')).toBe(true);
    expect(meetsMinimumTier('cuda-mid', 'cuda-low')).toBe(true);
    expect(meetsMinimumTier('cuda-high', 'cuda-high')).toBe(true);
  });

  it('rejects tiers below the minimum', () => {
    expect(meetsMinimumTier('cpu-only', 'cuda-low')).toBe(false);
    expect(meetsMinimumTier('cuda-low', 'cuda-mid')).toBe(false);
    expect(meetsMinimumTier('cuda-mid', 'cuda-high')).toBe(false);
  });
});

describe('recommendLocalModel — full tier × model matrix', () => {
  const TIERS: Array<HardwareReport['tier']> = ['cpu-only', 'cuda-low', 'cuda-mid', 'cuda-high'];

  it('only ever recommends models whose minTier is satisfied (or CPU fallback)', () => {
    for (const tier of TIERS) {
      for (const freeVramMB of [0, 1500, 2700, 4500, 6000, 8000]) {
        const rec = recommendLocalModel(report({ tier, gpu: tier === 'cpu-only' ? null : report().gpu }), freeVramMB);
        expect(LOCAL_MODEL_CATALOG.some((m) => m.id === rec.model)).toBe(true);
        if (rec.budget.fitsInVram) {
          expect(meetsMinimumTier(tier, rec.spec.minTier)).toBe(true);
        } else {
          expect(rec.spec.cpuFallback).toBe(true);
          expect(rec.budget.cpuFallback).toBe(true);
        }
      }
    }
  });

  it('BUG L1: phi3.5 is now reachable on cuda-high (was invisible)', () => {
    // 3 GB free on a cuda-high GPU: phi3.5 (2900 MB) fits, and with the
    // policy ranks llama3.2:3b (2600, rank 84) still wins the recommendation
    // — but phi3.5 must at least be GRADED and eligible in the catalog.
    const graded = gradeCatalog(report(), 3000);
    const phi = graded.find((m) => m.id.startsWith('phi3.5'));
    expect(phi?.fit.category).toBe('good');
  });

  it('BUG L1: qwen2.5:1.5b is gradable on cuda-high (was invisible)', () => {
    const graded = gradeCatalog(report(), 5000);
    const light = graded.find((m) => m.id.startsWith('qwen2.5:1.5b'));
    expect(light?.fit.category).toBe('excellent'); // 5000 vs 1400 → >1.25× headroom
  });

  it('prefers qwen2.5:7b with llama3.2:3b alternative on a comfortable RTX 4050', () => {
    const rec = recommendLocalModel(report());
    expect(rec.model).toBe('qwen2.5:7b-instruct-q4_K_M');
    expect(rec.budget.fitsInVram).toBe(true);
    expect(rec.fit.category).toBe('good'); // 5412 vs 5400 → fits, <1.25× headroom
    expect(rec.alternative?.model).toBe('llama3.2:3b-instruct-q4_K_M');
  });

  it('grades excellent when headroom is >= 25%', () => {
    const rec = recommendLocalModel(report(), 8000);
    expect(rec.model).toBe('qwen2.5:7b-instruct-q4_K_M');
    expect(rec.fit.category).toBe('excellent');
    expect(rec.fit.headroomMB).toBe(2600);
  });

  it('falls to llama3.2:3b when only ~2.7 GB is free', () => {
    const rec = recommendLocalModel(report({ tier: 'cuda-low' }), 2700);
    expect(rec.model).toBe('llama3.2:3b-instruct-q4_K_M');
    expect(rec.fit.category).toBe('good');
  });

  it('picks the ultra-light model when free VRAM is tiny', () => {
    const rec = recommendLocalModel(report({ tier: 'cuda-low' }), 1500);
    expect(rec.model).toBe('qwen2.5:1.5b-instruct-q4_K_M');
    expect(rec.budget.fitsInVram).toBe(true);
  });

  it('reports partial-offload honestly when the GPU is slightly too small', () => {
    // 1.5b needs 1400; 1200 free = 0.857 ratio → usable (partial offload)
    expect(fitCategoryFor(LOCAL_MODEL_CATALOG.find((m) => m.id.startsWith('qwen2.5:1.5b'))!, 1200, true)).toBe('usable');
    // 1000 free = 0.71 ratio → cpu-fallback
    expect(fitCategoryFor(LOCAL_MODEL_CATALOG.find((m) => m.id.startsWith('qwen2.5:1.5b'))!, 1000, true)).toBe('cpu-fallback');
  });

  it('falls back to CPU honestly when no GPU exists', () => {
    const rec = recommendLocalModel(report({ tier: 'cpu-only', gpu: null }));
    expect(rec.budget.cpuFallback).toBe(true);
    expect(rec.rationale).toMatch(/CPU/i);
    expect(rec.fit.category).toBe('cpu-fallback');
    // CPU-only picks the model whose CPU speed is actually usable (1.5b).
    expect(rec.model).toBe('qwen2.5:1.5b-instruct-q4_K_M');
  });

  it('grades tier-ineligible models honestly (cpu-fallback, not a fake GPU fit)', () => {
    // qwen3:8b declares minTier cuda-high. On a cuda-mid box it is NOT
    // eligible for GPU placement — but it HAS a CPU fallback, so the honest
    // grade is cpu-fallback ("runs, but on CPU"), never a fake "good fit".
    const gradedHigh = gradeCatalog(report({ tier: 'cuda-high' }), 6000);
    expect(gradedHigh.find((m) => m.id === 'qwen3:8b')?.fit.category).toBe('good');
    const gradedMid = gradeCatalog(report({ tier: 'cuda-mid' }), 6000);
    expect(gradedMid.find((m) => m.id === 'qwen3:8b')?.fit.category).toBe('cpu-fallback');
  });
});

describe('catalog integrity (verified-live policy)', () => {
  it('contains the three v1.9.0 additions with honest registry sizes', () => {
    const ids = LOCAL_MODEL_CATALOG.map((m) => m.id);
    expect(ids).toContain('qwen3:4b');
    expect(ids).toContain('qwen3:8b');
    expect(ids).toContain('gemma3:4b');
    const qwen3 = LOCAL_MODEL_CATALOG.find((m) => m.id === 'qwen3:4b')!;
    // ollama.com/library/qwen3:4b lists a 2.5 GB download.
    expect(qwen3.downloadMB).toBeGreaterThanOrEqual(2400);
    expect(qwen3.downloadMB).toBeLessThanOrEqual(2800);
  });

  it('marks gemma3:4b as the only vision-capable catalog entry', () => {
    const vision = LOCAL_MODEL_CATALOG.filter((m) => m.vision);
    expect(vision.map((m) => m.id)).toEqual(['gemma3:4b']);
  });

  it('gives every model a rank and a fit label vocabulary', () => {
    for (const spec of LOCAL_MODEL_CATALOG) {
      expect(spec.rank).toBeGreaterThan(0);
      expect(spec.cpuFallbackSpeed).toBeTruthy();
      expect(spec.notes.length).toBeGreaterThan(10);
    }
    expect(FIT_LABEL.excellent).toMatch(/excellent/i);
    expect(FIT_LABEL['cpu-fallback']).toMatch(/CPU/i);
  });

  it('excludes llama3.3 (only ships as a 43 GB 70B — dishonest for target GPUs)', () => {
    expect(LOCAL_MODEL_CATALOG.some((m) => m.id.startsWith('llama3.3'))).toBe(false);
  });
});

describe('gradeCatalog', () => {
  it('grades every entry and keeps the recommended flag derivable', () => {
    const graded = gradeCatalog(report());
    expect(graded).toHaveLength(LOCAL_MODEL_CATALOG.length);
    for (const entry of graded) {
      expect(entry.fit.category).toBeTruthy();
      expect(entry.fit.label).toBeTruthy();
      expect(typeof entry.fit.headroomMB).toBe('number');
    }
  });

  it('marks CPU-fallback models eligible even on cpu-only hardware', () => {
    const graded = gradeCatalog(report({ tier: 'cpu-only', gpu: null }));
    for (const entry of graded) {
      expect(entry.eligible).toBe(true); // every current catalog model has cpuFallback
    }
  });
});
