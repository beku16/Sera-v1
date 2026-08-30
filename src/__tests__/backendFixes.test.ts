import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeMemoryStore } from '../memory/NodeMemoryStore';
import { ProviderRegistry } from '../orchestration/ProviderRegistry';
import { ModelRouter } from '../orchestration/ModelRouter';
import { ProviderHealthMonitor } from '../orchestration/ProviderHealthMonitor';
import { CostController } from '../orchestration/CostController';
import { PerformanceMemory } from '../orchestration/PerformanceMemory';
import { ToolManager } from '../tools/ToolManager';
import { ToolDefinition, ToolPermissionLevel } from '../tools/types';
import { defaultComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';
import type { ProviderDescriptor } from '../orchestration/types';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sera-v1.6.11-tests-'));
}

/* ── NodeMemoryStore — atomic persistence ──────────────────────────────── */

describe('NodeMemoryStore v1.6.11 — atomic + serialized persistence', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = tempDir();
    file = path.join(dir, 'mem.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists atomically — no .tmp debris left behind after saves', async () => {
    const store = new NodeMemoryStore(file);
    await store.save({ fact: 'user likes tea', category: 'preference', source: 'user', confidence: 'high' });
    await store.save({ fact: 'user lives in Lisbon', category: 'other', source: 'user', confidence: 'high' });

    const files = fs.readdirSync(dir);
    expect(files).toEqual(['mem.json']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveLength(2);
  });

  it('survives a reload from disk (no silent reset)', async () => {
    const store = new NodeMemoryStore(file);
    await store.save({ fact: 'persisted fact', category: 'preference', source: 'user', confidence: 'high' });

    const reloaded = new NodeMemoryStore(file);
    const items = await reloaded.all();
    expect(items).toHaveLength(1);
    expect(items[0].fact).toBe('persisted fact');
  });

  it('serializes concurrent saves — every write lands intact', async () => {
    const store = new NodeMemoryStore(file);
    await store.init();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.save({ fact: `fact ${i}`, category: 'preference', source: 'user', confidence: 'high' })),
    );
    const items = await store.all();
    expect(items).toHaveLength(25);
    // The file is valid JSON (a torn write would fail this parse).
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
  });
});

/* ── ProviderRegistry — paid provider authorization ────────────────────── */

describe('ProviderRegistry v1.6.11 — paid providers are usable after enable', () => {
  it('enabling a paid provider marks it userAuthorized (the forever-rejected bug)', () => {
    const dir = tempDir();
    try {
      const registry = new ProviderRegistry(dir);
      const before = registry.get('openai');
      expect(before?.enabled).toBe(false);
      expect(before?.userAuthorized).toBe(false);

      expect(registry.setEnabled('openai', true)).toBe(true);
      const after = registry.get('openai');
      expect(after?.enabled).toBe(true);
      expect(after?.userAuthorized).toBe(true); // THE fix
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disabling a paid provider revokes the authorization (never spend silently)', () => {
    const dir = tempDir();
    try {
      const registry = new ProviderRegistry(dir);
      registry.setEnabled('openai', true);
      registry.setEnabled('openai', false);
      const after = registry.get('openai');
      expect(after?.enabled).toBe(false);
      expect(after?.userAuthorized).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the authorization persists across a registry reload', () => {
    const dir = tempDir();
    try {
      const registry = new ProviderRegistry(dir);
      registry.setEnabled('deepseek', true);
      const reloaded = new ProviderRegistry(dir);
      const deepseek = reloaded.get('deepseek');
      expect(deepseek?.enabled).toBe(true);
      expect(deepseek?.userAuthorized).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('free providers stay authorized-through-enablement untouched', () => {
    const dir = tempDir();
    try {
      const registry = new ProviderRegistry(dir);
      registry.setEnabled('groq', false);
      const groq = registry.get('groq');
      expect(groq?.enabled).toBe(false);
      // Free providers were never gated by userAuthorized — unchanged behavior.
      expect(groq?.userAuthorized).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ── ModelRouter — latency scoring tiers ───────────────────────────────── */

describe('ModelRouter v1.6.11 — latency penalty tiers actually apply', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeRouter(avgLatencyMs: number) {
    const health = new ProviderHealthMonitor();
    const cost = new CostController(dir);
    const performance = new PerformanceMemory(dir);
    const provider: ProviderDescriptor = {
      id: 'test-provider',
      name: 'Test Provider',
      type: 'free',
      endpoint: 'https://example.test/v1',
      authMethod: 'bearer',
      keyProviderId: 'gemini',
      enabled: true,
      priority: 0,
      freeTier: 'vendor_documented',
      trustedForPrivate: false,
      userAuthorized: false,
      models: [
        {
          id: 'model-a',
          label: 'Model A',
          caps: {
            fast_response: 5, reasoning: 5, coding: 5, vision: 0, tool_calling: 5,
            long_context: 5, multimodal: 0, stt: 0, tts: 0, summarization: 5, translation: 5,
          },
          contextWindow: 32768,
          supportsTools: true,
          supportsVision: false,
          supportsStreaming: true,
          latencyClass: 'fast',
        },
      ],
    };
    health.recordSuccess('test-provider', avgLatencyMs);
    const router = new ModelRouter({
      health,
      cost,
      performance,
      hasCredential: () => true,
    });
    return { router, provider };
  }

  it('scores a very slow provider (12s) strictly below a merely slow one (5s)', () => {
    const { router: verySlowRouter, provider } = makeRouter(10_500);
    const { router: mildlySlowRouter } = makeRouter(5_000);
    const ctx = { text: 'summarize this chapter', estimatedTokens: 1000 };

    const verySlow = verySlowRouter.route(ctx, [provider], 'balanced');
    const mildlySlow = mildlySlowRouter.route(ctx, [provider], 'balanced');

    expect(verySlow.selected).not.toBeNull();
    expect(mildlySlow.selected).not.toBeNull();
    const verySlowLatency = verySlow.selected!.breakdown.latencyScore;
    const mildlySlowLatency = mildlySlow.selected!.breakdown.latencyScore;
    // Before the fix the -3 tier (>10000ms) was unreachable dead code — a
    // 12-second provider scored the same as a 5-second one.
    expect(verySlowLatency).toBeLessThan(mildlySlowLatency);
  });
});

/* ── ToolManager — throw guards + execution eviction ───────────────────── */

function makeCrashyTool(): ToolDefinition<any, any> {
  return {
    name: 'crashyTool',
    description: 'A tool whose validateArgs throws',
    permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
    parameters: { type: 'object' as const, properties: {} },
    validateArgs: () => {
      throw new Error('validator exploded');
    },
    execute: async () => ({ success: true, data: { ok: 1 } }),
  } as unknown as ToolDefinition<any, any>;
}

describe('ToolManager v1.6.11 — tool-provided code can no longer crash the batch', () => {
  it('a THROWING validateArgs returns a structured failure instead of rejecting', async () => {
    const manager = new ToolManager(undefined, defaultComputerAuthorizationManager);
    manager.registerTool(makeCrashyTool());

    const result = await manager.executeTool('crashyTool', {});
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('validator exploded');
  });

  it('a THROWING capabilityForArgs returns a structured failure instead of rejecting', async () => {
    const manager = new ToolManager(undefined, defaultComputerAuthorizationManager);
    manager.registerTool({
      name: 'crashyCaps',
      description: 'capabilityForArgs throws',
      permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
      parameters: { type: 'object' as const, properties: {} },
      capabilityForArgs: () => {
        throw new Error('caps exploded');
      },
      validateArgs: () => ({ valid: true, parsedArgs: {} }),
      execute: async () => ({ success: true, data: { ok: 1 } }),
    } as unknown as ToolDefinition<any, any>);

    const result = await manager.executeTool('crashyCaps', {});
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('caps exploded');
  });

  it('settled executions are evicted after the dedupe window (memory-leak fix)', async () => {
    const manager = new ToolManager(undefined, defaultComputerAuthorizationManager, { executionRetentionMs: 60 });
    let calls = 0;
    manager.registerTool({
      name: 'countingTool',
      description: 'counts executions',
      permissionLevel: ToolPermissionLevel.LOW_RISK_ACTION,
      parameters: { type: 'object' as const, properties: {} },
      validateArgs: () => ({ valid: true, parsedArgs: {} }),
      execute: async () => {
        calls += 1;
        return { success: true, data: { calls } };
      },
    } as unknown as ToolDefinition<any, any>);

    // Same executionId while the settled entry is retained → deduped.
    const first = await manager.executeTool('countingTool', {}, { sessionId: 'default', executionId: 'exec-1' });
    const duplicate = await manager.executeTool('countingTool', {}, { sessionId: 'default', executionId: 'exec-1' });
    expect(calls).toBe(1);
    expect((duplicate.data as { calls: number }).calls).toBe(1);
    expect(first.success).toBe(true);

    // After the retention window the entry is gone → a new execution runs.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const fresh = await manager.executeTool('countingTool', {}, { sessionId: 'default', executionId: 'exec-1' });
    expect((fresh.data as { calls: number }).calls).toBe(2);
  });
});
