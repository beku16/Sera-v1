import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoalPlanner } from '../agi/GoalPlanner';
import { ExecutionGraph } from '../agi/ExecutionGraph';
import { PerceptionEngine } from '../agi/PerceptionEngine';
import { resolveArgsTemplate } from '../agi/planTypes';
import { ToolManager } from '../tools/ToolManager';
import { ToolDefinition, ToolPermissionLevel } from '../tools/types';
import type { ToolExecutionResult } from '../tools/types';

/** Minimal fake tool factory. */
function fakeTool(
  name: string,
  handler: (args: Record<string, unknown>) => ToolExecutionResult<unknown>,
): ToolDefinition<any, any> {
  return {
    name,
    description: `fake ${name}`,
    permissionLevel: ToolPermissionLevel.READ_ONLY,
    parameters: { type: 'OBJECT', properties: {} },
    validateArgs: (args) => ({ valid: true, parsedArgs: (args || {}) as Record<string, unknown> }),
    execute: async (args) => handler(args as Record<string, unknown>),
  };
}

describe('GoalPlanner', () => {
  const planner = new GoalPlanner();

  it('decomposes an open-app-and-type goal into a verified DAG', async () => {
    const plan = await planner.decompose('open calculator and type "25*25"');
    expect(plan.steps.length).toBe(3);
    expect(plan.steps[0].tool).toBe('openApplication');
    expect(plan.steps[0].verification?.kind).toBe('window_visible');
    expect(plan.steps[1].dependsOn).toEqual([plan.steps[0].id]);
    expect(plan.steps[1].args).toMatchObject({ operation: 'type' });
    expect(plan.steps[2].verification?.kind).toBe('text_contains');
  });

  it('decomposes an open-website goal', async () => {
    const plan = await planner.decompose('open https://github.com/beku16/sera');
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].tool).toBe('openWebsite');
    expect(String(plan.steps[0].args?.url)).toContain('github.com');
  });

  it('decomposes a web search goal', async () => {
    const plan = await planner.decompose('search for the best VRAM settings for qwen2.5');
    expect(plan.steps[0].tool).toBe('searchWeb');
    expect(String(plan.steps[0].args?.query)).toContain('qwen2.5');
  });

  it('decomposes clipboard and whatsapp goals', async () => {
    const clip = await planner.decompose('copy "hello world" to the clipboard');
    expect(clip.steps[0].tool).toBe('setClipboard');

    const wa = await planner.decompose('send message to Alice on whatsapp saying "see you soon"');
    expect(wa.steps[0].tool).toBe('sendWhatsAppMessage');
    expect(wa.steps[0].args).toMatchObject({ contact: 'Alice' });
  });

  it('falls back gracefully for unmatchable goals', async () => {
    const plan = await planner.decompose('tell me a joke about quantum physics');
    expect(plan.steps.length).toBe(0);
    expect(plan.strategySummary).toBeTruthy();
  });

  it('validates DAG structure and rejects cycles', () => {
    expect(planner.validateDag([
      { id: 'a', description: 'a', dependsOn: [] },
      { id: 'b', description: 'b', dependsOn: ['a'] },
    ])).toBe(true);

    expect(planner.validateDag([
      { id: 'a', description: 'a', dependsOn: ['b'] },
      { id: 'b', description: 'b', dependsOn: ['a'] },
    ])).toBe(false);

    expect(planner.validateDag([
      { id: 'a', description: 'a', dependsOn: ['ghost'] },
    ])).toBe(false);
  });

  it('uses the LLM planner when provided and valid', async () => {
    const llm = vi.fn().mockResolvedValue([
      { id: 'x1', description: 'llm step', tool: 'searchWeb', args: { query: 'llm' }, dependsOn: [] },
    ]);
    const plan = await planner.decompose('something unusual', { llmPlanner: llm });
    expect(plan.origin).toBe('llm');
    expect(plan.steps[0].id).toBe('x1');
  });

  it('falls back to heuristics when the LLM planner throws', async () => {
    const llm = vi.fn().mockRejectedValue(new Error('model offline'));
    const plan = await planner.decompose('open https://example.com', { llmPlanner: llm });
    expect(plan.origin).toBe('heuristic');
    expect(plan.steps[0].tool).toBe('openWebsite');
  });
});

describe('resolveArgsTemplate', () => {
  it('resolves captures from prior steps', () => {
    const captures = new Map<string, unknown>([['s1', { url: 'https://x.dev' }]]);
    const args = resolveArgsTemplate(
      { url: '${captures.s1.url}', label: 'site: ${captures.s1.url}' },
      captures,
    );
    expect(args?.url).toBe('https://x.dev');
    expect(args?.label).toBe('site: https://x.dev');
  });

  it('omits unknown captures and preserves plain values untouched', () => {
    const args = resolveArgsTemplate({ a: '${captures.ghost.q}', b: 5, c: true }, new Map());
    expect(args?.a).toBeUndefined(); // unknown capture → arg omitted
    expect(args?.b).toBe(5);
    expect(args?.c).toBe(true);
  });
});

describe('ExecutionGraph', () => {
  let toolManager: ToolManager;
  let perception: PerceptionEngine;
  let graph: ExecutionGraph;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    toolManager = new ToolManager();
    toolManager.registerTool(fakeTool('openApplication', (args) => {
      calls.push(`open:${String(args.application)}`);
      return { success: true, data: { launched: true } };
    }));
    toolManager.registerTool(fakeTool('controlComputerInput', (args) => {
      calls.push(`type:${String(args.text)}`);
      return { success: true, data: { typed: true } };
    }));
    toolManager.registerTool(fakeTool('inspectScreen', () => {
      calls.push('inspect');
      return { success: true, data: { text: '25*25 = 625' } };
    }));
    toolManager.registerTool(fakeTool('searchWeb', (args) => {
      calls.push(`search:${String(args.query)}`);
      return { success: true, data: { results: ['result one'] } };
    }));

    perception = new PerceptionEngine(toolManager);
    graph = new ExecutionGraph(toolManager, perception);
  });

  it('executes a dependency chain in order and verifies via OCR', async () => {
    const plan = {
      goal: 'test chain',
      strategySummary: 'test',
      plannedAt: Date.now(),
      origin: 'heuristic' as const,
      steps: [
        { id: 's1', description: 'open', tool: 'openApplication', args: { application: 'Calc' }, dependsOn: [] },
        { id: 's2', description: 'type', tool: 'controlComputerInput', args: { operation: 'type', text: '25*25' }, dependsOn: ['s1'] },
        {
          id: 's3', description: 'verify', tool: 'inspectScreen', args: {}, dependsOn: ['s2'],
          verification: { kind: 'text_contains' as const, value: '625' },
        },
      ],
    };

    const report = await graph.execute(plan, { sessionId: 'test' });
    expect(report.success).toBe(true);
    // inspectScreen runs twice: once as the step's tool, once inside the
    // PerceptionEngine OCR verification of the text_contains expectation.
    expect(calls.slice(0, 2)).toEqual(['open:Calc', 'type:25*25']);
    expect(calls.filter((c) => c === 'inspect').length).toBe(2);
    expect(report.results.every((r) => r.success && r.verified)).toBe(true);
  });

  it('runs independent steps in parallel', async () => {
    const plan = {
      goal: 'parallel test',
      strategySummary: 'test',
      plannedAt: Date.now(),
      origin: 'heuristic' as const,
      steps: [
        { id: 'p1', description: 'a', tool: 'searchWeb', args: { query: 'a' }, dependsOn: [], parallelizable: true },
        { id: 'p2', description: 'b', tool: 'searchWeb', args: { query: 'b' }, dependsOn: [], parallelizable: true },
      ],
    };
    const report = await graph.execute(plan, { sessionId: 'test' });
    expect(report.success).toBe(true);
    expect(report.results.length).toBe(2);
  });

  it('marks dependents as skipped when a dependency fails', async () => {
    toolManager.registerTool(fakeTool('alwaysFails', () => ({ success: false, error: 'permanent failure xyz' })));
    const plan = {
      goal: 'failure test',
      strategySummary: 'test',
      plannedAt: Date.now(),
      origin: 'heuristic' as const,
      steps: [
        { id: 'f1', description: 'doomed', tool: 'alwaysFails', args: {}, dependsOn: [] },
        { id: 'f2', description: 'blocked', tool: 'inspectScreen', args: {}, dependsOn: ['f1'] },
      ],
    };
    const report = await graph.execute(plan, { sessionId: 'test', maxAttemptsPerStep: 2 });
    expect(report.success).toBe(false);
    expect(report.results[0].success).toBe(false);
    expect(report.results[1].error).toMatch(/dependency failed/i);
  });

  it('retries after failure when reflection says retryable', async () => {
    let attempts = 0;
    toolManager.registerTool(fakeTool('flakyClipboard', () => {
      attempts += 1;
      if (attempts === 1) return { success: false, error: 'open clipboard failed: locked by another process' };
      return { success: true, data: { content: 'ok' } };
    }));

    const plan = {
      goal: 'flaky test',
      strategySummary: 'test',
      plannedAt: Date.now(),
      origin: 'heuristic' as const,
      steps: [
        { id: 'c1', description: 'clipboard', tool: 'flakyClipboard', args: {}, dependsOn: [] },
      ],
    };
    const report = await graph.execute(plan, { sessionId: 'test', maxAttemptsPerStep: 2 });
    expect(report.success).toBe(true);
    expect(attempts).toBe(2);
  });

  it('emits step progress events', async () => {
    const onStepStart = vi.fn();
    const onStepComplete = vi.fn();
    const plan = {
      goal: 'events test',
      strategySummary: 'test',
      plannedAt: Date.now(),
      origin: 'heuristic' as const,
      steps: [
        { id: 'e1', description: 'open', tool: 'openApplication', args: { application: 'Notepad' }, dependsOn: [] },
      ],
    };
    await graph.execute(plan, { sessionId: 'test', onStepStart, onStepComplete });
    expect(onStepStart).toHaveBeenCalledTimes(1);
    expect(onStepComplete).toHaveBeenCalledTimes(1);
  });
});

describe('PerceptionEngine', () => {
  it('perceives window state via tools and degrades gracefully on failure', async () => {
    const toolManager = new ToolManager();
    toolManager.registerTool(fakeTool('listWindows', () => ({
      success: true,
      data: { windows: [{ title: 'Calculator', ownerName: 'ApplicationFrameHost' }] },
    })));
    toolManager.registerTool(fakeTool('getActiveWindow', () => ({
      success: true,
      data: { title: 'Calculator' },
    })));
    toolManager.registerTool(fakeTool('inspectScreen', () => ({ success: false, error: 'ocr unavailable' })));

    const perception = new PerceptionEngine(toolManager);
    const snapshot = await perception.perceive({ includeOcr: true, sessionId: 'test' });
    expect(snapshot.windows.length).toBe(1);
    expect(snapshot.activeWindow?.title).toBe('Calculator');
    expect(snapshot.notes.some((n) => n.includes('inspectScreen'))).toBe(true);
  });

  it('verifies window visibility', async () => {
    const toolManager = new ToolManager();
    toolManager.registerTool(fakeTool('listWindows', () => ({
      success: true,
      data: { windows: [{ title: 'Untitled - Notepad' }] },
    })));
    const perception = new PerceptionEngine(toolManager);

    const ok = await perception.verify({ kind: 'window_visible' as const, value: 'notepad' }, { sessionId: 'test' });
    expect(ok.verified).toBe(true);

    const miss = await perception.verify({ kind: 'window_visible' as const, value: 'photoshop' }, { sessionId: 'test' });
    expect(miss.verified).toBe(false);
  });
});
