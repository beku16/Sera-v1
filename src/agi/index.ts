export {
  GoalPlanner,
  describeVerification,
} from './GoalPlanner';

export {
  PerceptionEngine,
  type DesktopSnapshot,
} from './PerceptionEngine';

export {
  ExecutionGraph,
  type ExecutionGraphOptions,
} from './ExecutionGraph';

export {
  type GoalPlan,
  type PlanStep,
  type PlanRunReport,
  type PlanStepResult,
  type VerificationExpectation,
  type VerificationKind,
  resolveArgsTemplate,
  extractCapture,
} from './planTypes';

import { ToolManager } from '../tools/ToolManager';
import { GoalPlanner } from './GoalPlanner';
import { PerceptionEngine } from './PerceptionEngine';
import { ExecutionGraph } from './ExecutionGraph';
import type { PlanStep } from './planTypes';

/**
 * The Autonomous Cognitive Engine facade — wires planner, perception and
 * execution into the complete Perceive → Plan → Execute → Verify loop.
 */
export class CognitiveEngine {
  public readonly planner: GoalPlanner;
  public readonly perception: PerceptionEngine;
  public readonly executor: ExecutionGraph;

  constructor(toolManager: ToolManager) {
    this.planner = new GoalPlanner();
    this.perception = new PerceptionEngine(toolManager);
    this.executor = new ExecutionGraph(toolManager, this.perception);
  }

  /**
   * Full loop for a broad voice instruction:
   *  perceive → decompose → DAG-execute (with verification + learning).
   *
   * `options.llmPlanner` (optional) is forwarded to GoalPlanner.decompose:
   * the orchestrator supplies one so complex goals are planned by the best
   * available model while the regex rules remain the offline fallback.
   */
  public async pursueGoal(
    goal: string,
    options: { sessionId?: string; includeOcrInPerception?: boolean; llmPlanner?: (goal: string) => Promise<PlanStep[] | null>; onStepStart?: (stepId: string, description: string) => void; onStepComplete?: (stepId: string, success: boolean, detail?: string) => void } = {},
  ) {
    const snapshot = await this.perception.perceive({ includeOcr: options.includeOcrInPerception, sessionId: options.sessionId });
    const plan = await this.planner.decompose(goal, { llmPlanner: options.llmPlanner });
    const report = await this.executor.execute(plan, {
      sessionId: options.sessionId,
      onStepStart: (step) => options.onStepStart?.(step.id, step.description),
      onStepComplete: (result) => options.onStepComplete?.(result.stepId, result.success, result.verificationDetail || result.error),
    });
    return { report, perception: snapshot };
  }
}
