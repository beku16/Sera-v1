import { ACTION_ERROR_CODES, ActionError, toActionError } from './errors';
import {
  Action,
  ActionExecutionContext,
  ActionExecutionResult,
  ActionExecutor,
  ActionLogEvent,
  ActionManagerOptions,
  CreateActionInput,
  VerificationResult,
} from './types';

export class ActionManager {
  private readonly executors: ActionExecutor[] = [];
  private readonly actions = new Map<string, Action<any, any>>();
  private readonly executions = new Map<string, Promise<Action>>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly logger: (event: ActionLogEvent) => void;
  // In desktop mode (Electron), the user has already opted in to computer
  // control by installing SERA. Default the per-session control flag to
  // 'authorized' so SENSITIVE_ACTION tools (input.* / screen.* / etc.) work
  // without forcing the user to call setComputerControlAuthorization first.
  // The explicit ComputerAuthorizationManager capability check still applies
  // separately above; this only flips the ActionManager's own gate.
  private readonly controlAuthorization = new Map<string, 'authorized' | 'revoked'>();

  constructor(options: ActionManagerOptions = {}) {
    this.idFactory = options.idFactory || (() => {
      if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
      return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    });
    this.now = options.now || (() => new Date().toISOString());
    this.logger = options.logger || ((event) => console.debug('[ActionManager]', event));
  }

  public registerExecutor(executor: ActionExecutor): void {
    if (this.executors.some((registered) => registered.name === executor.name)) {
      throw new Error(`Executor "${executor.name}" is already registered.`);
    }
    this.executors.push(executor);
  }

  public authorizeComputerControl(sessionId = 'default'): void {
    this.controlAuthorization.set(sessionId, 'authorized');
  }

  public revokeComputerControl(sessionId = 'default'): void {
    this.controlAuthorization.set(sessionId, 'revoked');
  }

  public getComputerControlAuthorization(sessionId = 'default'): 'unauthorized' | 'authorized' | 'revoked' {
    const explicit = this.controlAuthorization.get(sessionId);
    if (explicit) return explicit;
    // Desktop mode (Electron spawning the server) implies the user has
    // already opted in. Without this default, every SENSITIVE_ACTION tool
    // (input.*, screen.*, screenshot.*, window.focus, etc.) is silently
    // blocked with "Tool X requires user confirmation before execution."
    // and the entire computer-control surface area appears broken.
    if (process.env.SERA_DESKTOP_MODE === 'true' || process.env.SERA_AUTO_TRUST === 'true') {
      return 'authorized';
    }
    return 'unauthorized';
  }

  public isComputerControlAuthorized(sessionId = 'default'): boolean {
    return this.getComputerControlAuthorization(sessionId) === 'authorized';
  }

  public createAction<TParameters = Record<string, unknown>>(
    input: CreateActionInput<TParameters>
  ): Action<TParameters> {
    if (input.actionId) {
      const existing = this.actions.get(input.actionId);
      if (existing) return existing as Action<TParameters>;
    }
    const action: Action<TParameters> = {
      taskId: input.taskId || this.idFactory(),
      actionId: input.actionId || this.idFactory(),
      type: input.type,
      parameters: input.parameters,
      status: 'queued',
      createdAt: this.now(),
    };
    this.actions.set(action.actionId, action);
    return action;
  }

  public getAction(actionId: string): Action | undefined {
    return this.actions.get(actionId);
  }

  public async execute<TParameters = Record<string, unknown>, TResult = unknown>(
    action: Action<TParameters, TResult>
  ): Promise<Action<TParameters, TResult>> {
    const existing = this.executions.get(action.actionId);
    if (existing) return existing as Promise<Action<TParameters, TResult>>;

    const knownAction = this.actions.get(action.actionId);
    if (knownAction && knownAction !== action) return knownAction as Action<TParameters, TResult>;
    this.actions.set(action.actionId, action);

    const execution = this.executeOnce(action);
    this.executions.set(action.actionId, execution);
    return execution as Promise<Action<TParameters, TResult>>;
  }

  public async cancel(actionId: string): Promise<boolean> {
    const action = this.actions.get(actionId);
    if (!action || action.status === 'succeeded' || action.status === 'failed' || action.status === 'cancelled') return false;

    action.status = 'cancelled';
    action.completedAt = this.now();
    const controller = this.abortControllers.get(actionId);
    controller?.abort();

    const executor = this.findExecutor(action);
    await executor?.cancel?.(action);
    this.log(action, executor?.name || 'unassigned', { error: this.errorDetails(new ActionError(ACTION_ERROR_CODES.ACTION_CANCELLED, 'Action was cancelled.')) });
    return true;
  }

  public async cancelTask(taskId: string): Promise<number> {
    const matches = Array.from(this.actions.values()).filter((action) => action.taskId === taskId);
    let cancelled = 0;
    for (const action of matches) {
      if (await this.cancel(action.actionId)) cancelled++;
    }
    return cancelled;
  }

  private async executeOnce(action: Action<any, any>): Promise<Action<any, any>> {
    const executor = this.findExecutor(action);
    if (!executor) return this.fail(action, 'unassigned', new ActionError(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED, `No executor supports action type "${action.type}".`));

    const controller = new AbortController();
    this.abortControllers.set(action.actionId, controller);
    const startedAt = Date.now();
    action.startedAt = this.now();
    action.status = 'executing';

    const context: ActionExecutionContext = {
      signal: controller.signal,
      log: (event) => this.logger({ ...event, taskId: action.taskId, actionId: action.actionId, type: action.type, executor: executor.name, parameters: action.parameters }),
    };

    try {
      if (controller.signal.aborted || this.isCancelled(action)) return action;
      const execution = await executor.execute(action, context);
      if (controller.signal.aborted || this.isCancelled(action)) return action;

      action.result = execution.result;
      action.status = 'verifying';
      const verification = execution.verification || await executor.verify(action, execution, context);
      action.verification = verification;
      
      // Action status depends on verification status:
      // - 'success': action fully verified, status = 'succeeded'
      // - 'inconclusive': action executed, but observation remains pending
      // - 'failure': action verification failed, status = 'failed'
      if (verification.status === 'success') {
        action.status = 'succeeded';
        action.completedAt = this.now();
        this.log(action, executor.name, { executionTimeMs: Date.now() - startedAt, verification });
        return action;
      }
      
      if (verification.status === 'inconclusive') {
        action.status = 'inconclusive';
        action.completedAt = this.now();
        this.log(action, executor.name, { executionTimeMs: Date.now() - startedAt, verification });
        return action;
      }
      
      // verification.status === 'failure'
      const message = verification.message || 'Action verification failed.';
      return this.fail(action, executor.name, new ActionError(ACTION_ERROR_CODES.VERIFICATION_FAILED, message, verification.details), startedAt);
    } catch (error) {
      if (controller.signal.aborted || this.isCancelled(action)) return action;
      return this.fail(action, executor.name, toActionError(error), startedAt);
    } finally {
      this.abortControllers.delete(action.actionId);
    }
  }

  private findExecutor(action: Action<any, any>): ActionExecutor | undefined {
    return this.executors.find((executor) => executor.canHandle(action));
  }

  private isCancelled(action: Action<any, any>): boolean {
    return action.status === 'cancelled';
  }

  private fail(action: Action, executor: string, error: ActionError, startedAt?: number): Action {
    if (action.status !== 'cancelled') action.status = 'failed';
    action.error = this.errorDetails(error);
    action.completedAt = this.now();
    this.log(action, executor, {
      executionTimeMs: startedAt === undefined ? undefined : Date.now() - startedAt,
      verification: action.verification,
      error: action.error,
    });
    return action;
  }

  private errorDetails(error: ActionError) {
    return error.toDetails();
  }

  private log(action: Action, executor: string, event: Partial<ActionLogEvent>): void {
    this.logger({
      taskId: action.taskId,
      actionId: action.actionId,
      type: action.type,
      executor,
      parameters: action.parameters,
      ...event,
    });
  }
}

