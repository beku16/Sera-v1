import { GoalPlan, PlanRunReport, PlanStep, PlanStepResult, resolveArgsTemplate } from './planTypes';
import { PerceptionEngine } from './PerceptionEngine';
import { ToolManager } from '../tools/ToolManager';
import { defaultErrorReflectionEngine } from '../learning';

export interface ExecutionGraphOptions {
  sessionId?: string;
  /** Max attempts per step (initial try + reflective retries). */
  maxAttemptsPerStep?: number;
  /** Emit progress events for UI streaming. */
  onStepStart?: (step: PlanStep) => void;
  onStepComplete?: (result: PlanStepResult) => void;
}

/**
 * The Perception-Action-Verification executor.
 *
 * Walks the plan DAG in topological waves:
 *  1. Every step whose dependencies are satisfied becomes "ready".
 *  2. Ready steps execute — independent steps run in parallel.
 *  3. After each execution, the step's verification expectation is
 *     evaluated against fresh OS state (PerceptionEngine).
 *  4. On failure, the reflection engine produces a corrective hint +
 *     adjusted args and the step retries up to maxAttemptsPerStep.
 *  5. On eventual success, the proven workaround is learned.
 */
export class ExecutionGraph {
  constructor(
    private readonly toolManager: ToolManager,
    private readonly perception: PerceptionEngine,
  ) {}

  /**
   * Runs the plan to completion. Always resolves with a full report —
   * individual step failures do not throw; they mark the run failed.
   */
  public async execute(plan: GoalPlan, options: ExecutionGraphOptions = {}): Promise<PlanRunReport> {
    const startedAt = Date.now();
    const maxAttempts = options.maxAttemptsPerStep ?? 2;
    const results = new Map<string, PlanStepResult>();
    const captures = new Map<string, unknown>();

    // Steps with no tool are informational (LLM-provided notes) — treat as
    // auto-passing so dependents can proceed.
    const pending = new Set(plan.steps.map((s) => s.id));

    while (pending.size > 0) {
      const ready = plan.steps.filter(
        (step) => pending.has(step.id) && step.dependsOn.every((dep) => results.get(dep)?.success),
      );

      if (ready.length === 0) {
        // Remaining steps are blocked by failed dependencies.
        for (const stepId of pending) {
          const blocked = plan.steps.find((s) => s.id === stepId)!;
          const failedDeps = blocked.dependsOn.filter((dep) => results.get(dep) && !results.get(dep)!.success);
          results.set(stepId, {
            stepId,
            success: false,
            error: failedDeps.length
              ? `Skipped — dependency failed: ${failedDeps.join(', ')}`
              : 'Skipped — no satisfiable dependencies',
            verified: false,
            attempts: 0,
            startedAt: Date.now(),
            finishedAt: Date.now(),
          });
        }
        break;
      }

      // Execute this wave (parallel where steps are independent).
      const wave = ready.map(async (step) => {
        const result = await this.executeStep(step, { captures, maxAttempts, options });
        results.set(step.id, result);
        pending.delete(step.id);
        // Capture outputs for downstream templates: capture.<stepId>.*
        if (result.output && typeof result.output === 'object') {
          captures.set(step.id, result.output);
        }
        try {
          options.onStepComplete?.(result);
        } catch {
          // Listener errors must never break the run.
        }
        return result;
      });
      await Promise.all(wave);
    }

    const allResults = plan.steps.map((s) => results.get(s.id)!).filter(Boolean);
    const success = allResults.length > 0 && allResults.every((r) => r.success && (r.verified || !plan.steps.find((s) => s.id === r.stepId)?.verification));

    const failed = allResults.filter((r) => !r.success);
    const summary = success
      ? `Goal achieved: ${plan.goal} — ${allResults.length} step(s) completed and verified.`
      : `Goal incomplete: ${plan.goal} — ${failed.length}/${allResults.length} step(s) failed. First failure: ${failed[0]?.error || 'unknown'}`;

    return {
      goal: plan.goal,
      plan,
      results: allResults,
      success,
      startedAt,
      finishedAt: Date.now(),
      summary,
    };
  }

  /** Executes a single step with verification + reflective retry. */
  private async executeStep(
    step: PlanStep,
    context: { captures: Map<string, unknown>; maxAttempts: number; options: ExecutionGraphOptions },
  ): Promise<PlanStepResult> {
    const startedAt = Date.now();

    if (!step.tool) {
      return { stepId: step.id, success: true, verified: true, attempts: 0, startedAt, finishedAt: Date.now(), verificationDetail: 'informational step' };
    }

    let lastError = '';
    let lastOutput: unknown;

    for (let attempt = 1; attempt <= context.maxAttempts; attempt++) {
      context.options.onStepStart?.(step);
      // NOTE: pre-flight anti-regression arg adjustment happens inside
      // ToolManager itself (via the attached learning engine), so the
      // graph always passes the planner's canonical args.
      const args = resolveArgsTemplate(step.args, context.captures) || {};

      const result = await this.toolManager.executeTool(step.tool, args, {
        sessionId: context.options.sessionId,
        executionId: `agi-${step.id}-${attempt}`,
      });

      if (result.success) {
        lastOutput = result.data;
        // Verification phase.
        if (step.verification) {
          const verification = await this.perception.verify(step.verification, { sessionId: context.options.sessionId });
          if (verification.verified) {
            if (lastError) {
              // Close the learning loop: the retry with this approach worked.
              defaultErrorReflectionEngine.learnWorkaround(step.tool, lastError, step.verification.description || 'retry after reflective adjustment', args);
            }
            return { stepId: step.id, success: true, output: result.data, verified: true, verificationDetail: verification.detail, attempts: attempt, startedAt, finishedAt: Date.now() };
          }

          lastError = lastError || `verification failed: ${verification.detail}`;
          if (attempt >= context.maxAttempts) {
            return { stepId: step.id, success: false, error: `Executed but ${verification.detail}`, output: result.data, verified: false, attempts: attempt, startedAt, finishedAt: Date.now() };
          }
          continue; // retry with the reflective hint available
        }

        // No verification expectation — tool success is enough.
        if (lastError) {
          defaultErrorReflectionEngine.learnWorkaround(step.tool, lastError, 'retried successfully', args);
        }
        return { stepId: step.id, success: true, output: result.data, verified: true, verificationDetail: 'no verification expectation — tool success', attempts: attempt, startedAt, finishedAt: Date.now() };
      }

      // Tool execution failed — reflect.
      lastError = result.error || 'unknown tool error';
      const reflection = defaultErrorReflectionEngine.reflect(step.tool, args, lastError, { sessionId: context.options.sessionId });
      lastOutput = { reflection: reflection.analysis, hint: reflection.correctiveHint };

      if (!reflection.shouldRetry || attempt >= context.maxAttempts) {
        return { stepId: step.id, success: false, error: lastError, output: lastOutput, verified: false, attempts: attempt, startedAt, finishedAt: Date.now() };
      }
    }

    return { stepId: step.id, success: false, error: lastError || 'exhausted attempts', output: lastOutput, verified: false, attempts: context.maxAttempts, startedAt, finishedAt: Date.now() };
  }
}
