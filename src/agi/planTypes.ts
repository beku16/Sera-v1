/**
 * A single step in a hierarchical goal decomposition.
 */
export interface PlanStep {
  id: string;
  /** Natural-language description of this sub-task. */
  description: string;
  /** Tool that should accomplish it (hint — the executor may adapt). */
  tool?: string;
  /** Arguments template; `${captures.name}` placeholders are resolved. */
  args?: Record<string, unknown>;
  /** IDs of steps that must complete before this one starts. */
  dependsOn: string[];
  /** Optional verification expectation evaluated after execution. */
  verification?: VerificationExpectation;
  /** Parallel execution hint — independent steps may run concurrently. */
  parallelizable?: boolean;
}

export type VerificationKind = 'window_visible' | 'text_contains' | 'process_running' | 'clipboard_equals' | 'tool_success';

export interface VerificationExpectation {
  kind: VerificationKind;
  /** Window title fragment / OCR needle / process name / clipboard value. */
  value?: string;
  /** Optional description for logs + UI. */
  description?: string;
}

export interface GoalPlan {
  goal: string;
  /** Short summary of the strategy the planner chose. */
  strategySummary: string;
  steps: PlanStep[];
  plannedAt: number;
  /** 'heuristic' (pattern rules) or 'llm' (model-generated). */
  origin: 'heuristic' | 'llm';
}

export interface PlanStepResult {
  stepId: string;
  success: boolean;
  error?: string;
  output?: unknown;
  verified: boolean;
  verificationDetail?: string;
  attempts: number;
  startedAt: number;
  finishedAt: number;
}

export interface PlanRunReport {
  goal: string;
  plan: GoalPlan;
  results: PlanStepResult[];
  success: boolean;
  startedAt: number;
  finishedAt: number;
  summary: string;
}

/**
 * Deterministic execution of a `${captures.x}` template against results
 * captured from previous steps. Placeholders resolve like:
 *   { application: "${captures.appName}" } with captures { appName: "Notepad" }
 *   { url: "${captures.s1.result.url}" } — dotted paths walk nested objects.
 */
export function resolveArgsTemplate(args: Record<string, unknown> | undefined, captures: Map<string, unknown>): Record<string, unknown> | undefined {
  if (!args) return undefined;

  const lookup = (key: string, path: string | null): unknown => {
    const base = captures.get(key);
    if (path === null) return base;
    // Walk the dotted path through nested objects/arrays.
    let current: unknown = base;
    for (const segment of path.split('.')) {
      if (current === null || current === undefined) return undefined;
      if (Array.isArray(current)) {
        const index = Number.parseInt(segment, 10);
        current = Number.isInteger(index) ? current[index] : undefined;
        continue;
      }
      if (typeof current === 'object') {
        current = (current as Record<string, unknown>)[segment];
        continue;
      }
      return undefined;
    }
    return current;
  };

  const resolveValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      // Whole-string placeholder → preserve the native value type.
      const fullDotted = value.match(/^\$\{captures\.([\w-]+)\.([\w.-]+)\}$/);
      if (fullDotted) return lookup(fullDotted[1], fullDotted[2]);
      const fullFlat = value.match(/^\$\{captures\.([\w-]+)\}$/);
      if (fullFlat) return lookup(fullFlat[1], null);

      // Inline placeholders → string interpolation.
      return value
        .replace(/\$\{captures\.([\w-]+)\.([\w.-]+)\}/g, (_, key: string, path: string) => {
          const resolved = lookup(key, path);
          return resolved === undefined || resolved === null ? '' : String(resolved);
        })
        .replace(/\$\{captures\.([\w-]+)\}/g, (_, key: string) => {
          const resolved = lookup(key, null);
          return resolved === undefined || resolved === null ? '' : String(resolved);
        });
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveValue(v)]));
    }
    return value;
  };

  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, resolveValue(v)]));
}

/**
 * Extracts a named capture from a tool result (used by planner rules).
 */
export function extractCapture(output: unknown, path: string): unknown {
  let current: unknown = output;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}
