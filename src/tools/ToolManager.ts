import { ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolPermissionLevel } from './types';
import { ActionManager } from '../actions/ActionManager';
import { Action } from '../actions/types';
import { defaultSpeakerManager } from '../speakers';
import { ComputerAuthorizationManager, ComputerCapability, defaultComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';
import { ErrorReflectionEngine } from '../learning/ErrorReflectionEngine';

export type ToolEventListener = (event: {
  type: 'invoked' | 'success' | 'failed';
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
}) => void;

export class ToolManager {
  private tools: Map<string, ToolDefinition<any, any>> = new Map();
  private listeners: Set<ToolEventListener> = new Set();
  private executions = new Map<string, Promise<ToolExecutionResult<unknown>>>();
  private readonly maxExecutionHistory = 1000;
  /** How long a settled execution stays available for dedupe lookups. */
  private executionRetentionMs: number;
  private requireConfirmationForLevels: Set<ToolPermissionLevel> = new Set([
    ToolPermissionLevel.SENSITIVE_ACTION,
    ToolPermissionLevel.DANGEROUS_ACTION,
  ]);

  constructor(
    private readonly actionManager: ActionManager = new ActionManager(),
    private readonly authorization: ComputerAuthorizationManager = defaultComputerAuthorizationManager,
    options: { executionRetentionMs?: number } = {},
  ) {
    this.executionRetentionMs = options.executionRetentionMs ?? 60_000;
  }

  /**
   * Meta-cognitive learning pipeline (spec section E). When attached,
   * every execution passes through:
   *  - PRE-FLIGHT: mistake-memory anti-regression check that may rewrite
   *    arguments to avoid known past failures.
   *  - POST-MORTEM: on failure, a structured reflection is produced and
   *    the lesson persisted to sera_mistake_memory.json.
   * Optional by design so bare ToolManagers (tests, embedding hosts)
   * keep their exact previous behavior.
   */
  private learningEngine: ErrorReflectionEngine | null = null;

  public attachLearning(engine: ErrorReflectionEngine): void {
    this.learningEngine = engine;
  }

  public getLearningEngine(): ErrorReflectionEngine | null {
    return this.learningEngine;
  }

  public getActionManager(): ActionManager {
    return this.actionManager;
  }

  public dispatchAction(action: Action): Promise<Action> {
    return this.actionManager.execute(action);
  }

  /**
   * Register a new tool definition
   */
  public registerTool(tool: ToolDefinition<any, any>): void {
    if (!tool.name) {
      throw new Error('Tool must have a name.');
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Retrieves a tool by name
   */
  public getTool(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /**
   * Returns all registered tools
   */
  public getAllTools(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Converts registered tools into Gemini FunctionDeclaration format for the Live API
   */
  public getGeminiFunctionDeclarations(): Array<{
    name: string;
    description: string;
    parameters: any;
  }> {
    const convertProperty = (property: any): any => {
      const schema: Record<string, any> = {
        type: property.type,
        description: property.description,
      };

      if (property.enum) schema.enum = property.enum;
      if (property.items) schema.items = convertProperty(property.items);
      if (property.properties) {
        schema.properties = Object.entries(property.properties).reduce((acc, [key, nested]) => {
          acc[key] = convertProperty(nested);
          return acc;
        }, {} as Record<string, any>);
      }
      if (property.required) schema.required = property.required;

      return schema;
    };

    return this.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: {
        type: tool.parameters.type,
        properties: Object.entries(tool.parameters.properties).reduce((acc, [key, prop]) => {
          acc[key] = convertProperty(prop);
          return acc;
        }, {} as Record<string, any>),
        required: tool.parameters.required || [],
      },
    }));
  }

  /**
   * Executes a tool with argument validation and permission checks.
   *
   * v1.6.11 MEMORY FIX: the executions map used to retain up to 1,000
   * RESOLVED promise results forever — including full base64 screenshots
   * (~500KB each; worst case hundreds of MB). Settled entries are now
   * evicted after a short dedupe window, and the hard cap remains as a
   * backstop.
   */
  public async executeTool(
    name: string,
    rawArgs: unknown,
    context?: ToolExecutionContext
  ): Promise<ToolExecutionResult<unknown>> {
    if (context?.executionId) {
      const existingExecution = this.executions.get(context.executionId);
      if (existingExecution) return existingExecution;

      const execution = this.executeToolInternal(name, rawArgs, context);
      this.executions.set(context.executionId, execution);
      if (this.executions.size > this.maxExecutionHistory) {
        const oldestExecutionId = this.executions.keys().next().value;
        if (oldestExecutionId) {
          this.executions.delete(oldestExecutionId);
        }
      }
      // Evict shortly after settle — the promise result (possibly a huge
      // screenshot payload) is only needed for concurrent duplicate calls.
      void execution.catch(() => undefined).finally(() => {
        setTimeout(() => this.executions.delete(context.executionId!), this.executionRetentionMs).unref?.();
      });
      return await execution;
    }

    return this.executeToolInternal(name, rawArgs, context);
  }

  private async executeToolInternal(
    name: string,
    rawArgs: unknown,
    context?: ToolExecutionContext
  ): Promise<ToolExecutionResult<unknown>> {
    const tool = this.tools.get(name);

    if (!tool) {
      const errorMsg = `Tool "${name}" is not registered or supported.`;
      this.notifyListeners({
        type: 'failed',
        toolName: name,
        args: (rawArgs as Record<string, unknown>) || {},
        error: errorMsg,
      });
      return { success: false, error: errorMsg };
    }

    // Notify invoked
    this.notifyListeners({
      type: 'invoked',
      toolName: name,
      args: (rawArgs as Record<string, unknown>) || {},
    });

    // Check capability authorization first, then apply speaker/confirmation policy.
    const sessionId = context?.sessionId || 'default';
    // v1.6.11 FIX: capabilityForArgs is tool-provided code — a throw here
    // used to reject straight out of executeTool and (in the Gemini Live
    // loop) abort the whole tool-call batch. Guarded like every other
    // tool-provided callable.
    let requiredCapability: ComputerCapability | undefined;
    try {
      requiredCapability = tool.capabilityForArgs?.(rawArgs) || tool.capability;
    } catch (err) {
      const errorMsg = `Capability resolution failed for tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
      this.notifyListeners({ type: 'failed', toolName: name, args: (rawArgs as Record<string, unknown>) || {}, error: errorMsg });
      return { success: false, error: errorMsg };
    }
    // Capability authorization only gates tools at SENSITIVE_ACTION and
    // above (the same levels that require user confirmation below).
    // LOW_RISK_ACTION tools (openWebsite, searchWeb, openApplication,
    // captureScreenshot ...) are ordinary reversible everyday actions —
    // demanding computer-control capabilities for them denied every
    // system action in browser/PWA mode (no SERA_DESKTOP_MODE auto-trust),
    // which made "open youtube" / "search X" fail with "Capability
    // BROWSER_CONTROL requires authorization" even though the tool is
    // declared LOW_RISK. Risky tools keep the full authorization gate.
    const capabilityGated = Boolean(requiredCapability) && tool.permissionLevel !== ToolPermissionLevel.READ_ONLY && tool.permissionLevel !== ToolPermissionLevel.LOW_RISK_ACTION;
    if (capabilityGated && requiredCapability && !this.authorization.hasCapability(requiredCapability, sessionId) && !context?.userConfirmed) {
      const errorMsg = `Capability "${requiredCapability}" requires authorization.`;
      this.notifyListeners({ type: 'failed', toolName: name, args: (rawArgs as Record<string, unknown>) || {}, error: errorMsg });
      return { success: false, error: errorMsg };
    }

    if (this.requireConfirmationForLevels.has(tool.permissionLevel)) {
      const speakerPermission = context?.speakerId ? defaultSpeakerManager.permissionFor({ speakerId: context.speakerId, name: '', confidence: 'high', score: 1, known: true }) : undefined;
      if (context?.speakerId && speakerPermission !== 'full_control' && !context.userConfirmed) {
        const errorMsg = `Tool "${name}" requires an authorized speaker.`;
        this.notifyListeners({ type: 'failed', toolName: name, args: (rawArgs as Record<string, unknown>) || {}, error: errorMsg });
        return { success: false, error: errorMsg };
      }
      const controlAuthorized = requiredCapability
        ? this.authorization.hasCapability(requiredCapability, sessionId) || this.actionManager.isComputerControlAuthorized(sessionId)
        : this.actionManager.isComputerControlAuthorized(sessionId);
      if (!context?.userConfirmed && !controlAuthorized) {
        const errorMsg = `Tool "${name}" requires user confirmation before execution.`;
        this.notifyListeners({
          type: 'failed',
          toolName: name,
          args: (rawArgs as Record<string, unknown>) || {},
          error: errorMsg,
        });
        return {
          success: false,
          error: errorMsg,
        };
      }
    }

    // Validate arguments
    // v1.6.11 FIX: validateArgs is tool-provided code — a throw escaped the
    // manager entirely (same batch-abort risk as capabilityForArgs).
    let validation: { valid: boolean; error?: string; parsedArgs?: any };
    try {
      validation = tool.validateArgs(rawArgs);
    } catch (err) {
      const errorMsg = `Argument validation crashed for tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
      this.notifyListeners({ type: 'failed', toolName: name, args: (rawArgs as Record<string, unknown>) || {}, error: errorMsg });
      return { success: false, error: errorMsg };
    }
    if (!validation.valid) {
      const errorMsg = `Invalid arguments for tool "${name}": ${validation.error || 'Schema validation failed'}`;
      this.notifyListeners({
        type: 'failed',
        toolName: name,
        args: (rawArgs as Record<string, unknown>) || {},
        error: errorMsg,
      });
      // Learning: invalid args are failures too — record the lesson.
      this.learningEngine?.reflect(name, (rawArgs as Record<string, unknown>) || {}, errorMsg, { sessionId });
      return {
        success: false,
        error: errorMsg,
      };
    }

    // PRE-FLIGHT ANTI-REGRESSION CHECK: "Have I failed this before?
    // What worked last time?" The engine may adjust arguments (e.g.
    // inject focusApplication) based on stored mistake memory.
    let effectiveArgs: unknown = validation.parsedArgs;
    if (this.learningEngine) {
      try {
        const preFlight = this.learningEngine.preFlightCheck(name, validation.parsedArgs, { sessionId });
        if (preFlight.adjustedArgs) effectiveArgs = preFlight.adjustedArgs;
      } catch {
        // Learning must never break execution — ignore pre-flight errors.
      }
    }

    // Execute tool
    try {
      const result = await tool.execute(effectiveArgs, {
        ...context,
        actionManager: this.actionManager,
        authorizationManager: this.authorization,
      });

      if (result.success) {
        this.notifyListeners({
          type: 'success',
          toolName: name,
          args: validation.parsedArgs,
          result: result.data,
        });
      } else {
        this.notifyListeners({
          type: 'failed',
          toolName: name,
          args: validation.parsedArgs,
          error: result.error,
        });
        // ERROR POST-MORTEM LOOP: what was the goal? what error occurred?
        // why did it fail? what fix works? Persisted for future pre-flight.
        if (this.learningEngine && result.error) {
          try {
            this.learningEngine.reflect(name, validation.parsedArgs, result.error, { sessionId });
          } catch {
            // Reflection must never break the failure path.
          }
        }
      }

      return result;
    } catch (err) {
      const errorMsg = `Execution error in tool "${name}": ${err instanceof Error ? err.message : String(err)}`;
      this.notifyListeners({
        type: 'failed',
        toolName: name,
        args: validation.parsedArgs,
        error: errorMsg,
      });
      if (this.learningEngine) {
        try {
          this.learningEngine.reflect(name, validation.parsedArgs, errorMsg, { sessionId });
        } catch {
          // Reflection must never break the failure path.
        }
      }
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  public addListener(listener: ToolEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(event: Parameters<ToolEventListener>[0]): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error in tool event listener:', err);
      }
    }
  }
}



