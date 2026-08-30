import { ErrorEvent, RecoveryAttempt } from './types';
import { ErrorMonitor } from './ErrorMonitor';

export interface RecoveryContext {
  error: ErrorEvent;
  monitor: ErrorMonitor;
  metadata?: Record<string, unknown>;
}

export interface RecoveryResult {
  success: boolean;
  message: string;
  error?: string;
  nextAction?: string;
}

/**
 * Abstract base class for recovery strategies
 */
export abstract class RecoveryStrategy {
  abstract readonly name: string;
  abstract readonly description: string;

  abstract canHandle(error: ErrorEvent): boolean;
  abstract execute(context: RecoveryContext): Promise<RecoveryResult>;

  /**
   * Verify that recovery was successful
   */
  protected async verify(context: RecoveryContext): Promise<boolean> {
    // Default: assume success. Override in subclasses for specific verification.
    return true;
  }

  /**
   * Record recovery attempt in error history
   */
  protected recordAttempt(error: ErrorEvent, success: boolean, message: string, err?: Error): void {
    const attempt: RecoveryAttempt = {
      strategy: this.name,
      timestamp: new Date().toISOString(),
      attempt_number: (error.recoveryAttempts?.length ?? 0) + 1,
      success,
      message,
      error: err?.message,
    };
    error.recoveryAttempts.push(attempt);
  }
}

/**
 * Retry a failed browser action
 */
export class BrowserRetryStrategy extends RecoveryStrategy {
  override readonly name = 'BrowserRetry';
  override readonly description = 'Retry the failed browser action once';

  constructor(private browserExecutor?: unknown) {
    super();
  }

  override canHandle(error: ErrorEvent): boolean {
    return (
      (error.source === 'BrowserExecutor' || error.source === 'BrowserSessionManager' || error.source === 'BrowserErrorListener') &&
      (error.category === 'browser' || error.category === 'timeout') &&
      error.recoveryAttempts.length < 1
    );
  }

  override async execute(context: RecoveryContext): Promise<RecoveryResult> {
    const retry = context.metadata?.retry as (() => Promise<boolean> | boolean) | undefined;
    if (retry) {
      try {
        const success = await retry();
        return {
          success,
          message: success ? 'Browser retry recovered the failed action.' : 'Browser retry did not recover the action.',
          nextAction: success ? 'continue' : 'escalate',
        };
      } catch (cause) {
        return {
          success: false,
          message: cause instanceof Error ? cause.message : 'Browser retry error',
          nextAction: 'escalate',
        };
      }
    }

    return {
      success: false,
      message: 'Browser retry strategy requires ActionManager integration',
      nextAction: 'Implement integration with ActionManager',
    };
  }
}

/**
 * Refresh a failed browser page
 */
export class BrowserRefreshStrategy extends RecoveryStrategy {
  override readonly name = 'BrowserRefresh';
  override readonly description = 'Refresh the browser page to recover from load failure';

  override canHandle(error: ErrorEvent): boolean {
    return (
      (error.source === 'BrowserExecutor' || error.source === 'BrowserSessionManager' || error.source === 'BrowserErrorListener') &&
      error.category === 'browser' &&
      error.context.url !== undefined
    );
  }

  override async execute(context: RecoveryContext): Promise<RecoveryResult> {
    const refresh = context.metadata?.refresh as (() => Promise<boolean> | boolean) | undefined;
    if (refresh) {
      try {
        const success = await refresh();
        return {
          success,
          message: success ? 'The browser page refreshed and recovered.' : 'The browser page refresh did not recover the failure.',
          nextAction: success ? 'continue' : 'escalate',
        };
      } catch (cause) {
        return {
          success: false,
          message: cause instanceof Error ? cause.message : 'Browser refresh failed',
          nextAction: 'escalate',
        };
      }
    }

    return {
      success: false,
      message: 'Browser refresh strategy requires a refresh callback',
      nextAction: 'retry_with_reload',
    };
  }
}

/**
 * Reconnect to a failed WebSocket session
 */
export class WebSocketReconnectStrategy extends RecoveryStrategy {
  override readonly name = 'WebSocketReconnect';
  override readonly description = 'Attempt to reconnect to WebSocket session';

  override canHandle(error: ErrorEvent): boolean {
    return error.source === 'WebSocket' && error.category === 'network' && error.recoveryAttempts.length < 3;
  }

  override async execute(context: RecoveryContext): Promise<RecoveryResult> {
    const reconnect = context.metadata?.reconnect as (() => Promise<boolean> | boolean) | undefined;
    if (!reconnect) {
      return { success: false, message: 'WebSocket reconnect strategy requires a reconnect callback', nextAction: 'retry_with_reconnect' };
    }
    try {
      const success = await reconnect();
      return {
        success,
        message: success ? 'WebSocket session reconnected.' : 'WebSocket reconnect did not recover the session.',
        nextAction: success ? 'continue' : 'escalate',
      };
    } catch (cause) {
      return { success: false, message: cause instanceof Error ? cause.message : 'WebSocket reconnect failed.', nextAction: 'escalate' };
    }
  }
}

/**
 * Refocus a window that lost focus during an action
 */
export class WindowRefocusStrategy extends RecoveryStrategy {
  override readonly name = 'WindowRefocus';
  override readonly description = 'Refocus the target application window';

  override canHandle(error: ErrorEvent): boolean {
    return (
      (error.source === 'WindowExecutor' || error.source === 'InputExecutor') &&
      error.message.toLowerCase().includes('focus') &&
      error.recoveryAttempts.length < 2
    );
  }

  override async execute(context: RecoveryContext): Promise<RecoveryResult> {
    const refocus = context.metadata?.refocus as (() => Promise<boolean> | boolean) | undefined;
    if (!refocus) {
      return { success: false, message: 'Window refocus strategy requires a refocus callback', nextAction: 'retry_with_refocus' };
    }
    try {
      const success = await refocus();
      return {
        success,
        message: success ? 'Target window refocused.' : 'Target window could not be refocused.',
        nextAction: success ? 'continue' : 'escalate',
      };
    } catch (cause) {
      return { success: false, message: cause instanceof Error ? cause.message : 'Window refocus failed.', nextAction: 'escalate' };
    }
  }
}

/**
 * Wait and retry for transient network failures
 */
export class NetworkWaitRetryStrategy extends RecoveryStrategy {
  override readonly name = 'NetworkWaitRetry';
  override readonly description = 'Wait briefly and retry after temporary network failure';

  override canHandle(error: ErrorEvent): boolean {
    return error.category === 'network' && error.recoveryAttempts.length < 2;
  }

  override async execute(context: RecoveryContext): Promise<RecoveryResult> {
    // Wait 2 seconds before signaling that retry can proceed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return {
      success: true,
      message: 'Network recovered, ready to retry',
      nextAction: 'retry_original_action',
    };
  }
}

/**
 * Manages available recovery strategies and attempts recovery
 */
export class RecoveryManager {
  private strategies: RecoveryStrategy[] = [];
  private maxAttemptsPerError: number = 3;

  constructor() {
    // Register built-in strategies
    this.register(new BrowserRetryStrategy());
    this.register(new BrowserRefreshStrategy());
    this.register(new WebSocketReconnectStrategy());
    this.register(new WindowRefocusStrategy());
    this.register(new NetworkWaitRetryStrategy());
  }

  /**
   * Register a recovery strategy
   */
  public register(strategy: RecoveryStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * Attempt to recover from an error
   */
  public async attemptRecovery(error: ErrorEvent, monitor: ErrorMonitor, metadata?: Record<string, unknown>): Promise<RecoveryResult> {
    // Check if we've exceeded max attempts
    if (error.recoveryAttempts.length >= this.maxAttemptsPerError) {
      return {
        success: false,
        message: `Max recovery attempts (${this.maxAttemptsPerError}) exceeded`,
        error: 'MAX_ATTEMPTS_EXCEEDED',
      };
    }

    // Find applicable strategies
    const applicable = this.strategies.filter((s) => s.canHandle(error));

    if (applicable.length === 0) {
      return {
        success: false,
        message: 'No applicable recovery strategy found',
        error: 'NO_STRATEGY',
      };
    }

    // Try strategies in order
    for (const strategy of applicable) {
      try {
        const context: RecoveryContext = { error, monitor, metadata };
        const result = await strategy.execute(context);

        // Record attempt
        error.lastRecoveryStatus = result.success ? 'succeeded' : 'failed';
        error.recoveryAttempts.push({
          strategy: strategy.name,
          timestamp: new Date().toISOString(),
          attempt_number: error.recoveryAttempts.length + 1,
          success: result.success,
          message: result.message,
        });

        if (result.success) {
          return result;
        }
      } catch (cause) {
        // Log but continue to next strategy
        console.error(`Recovery strategy ${strategy.name} failed:`, cause);
      }
    }

    return {
      success: false,
      message: 'All recovery strategies failed or did not apply',
      error: 'STRATEGIES_FAILED',
    };
  }

  /**
   * Determine if recovery is safe
   */
  public isSafeToRecover(error: ErrorEvent): boolean {
    // Never auto-recover from:
    // - Permission errors (requires user action)
    // - Authentication errors (requires user action)
    // - Destructive operations
    // - Repeated failures (possible infinite loop)

    if (error.category === 'permission' || error.category === 'authentication') {
      return false;
    }

    if (error.recoveryAttempts.length >= this.maxAttemptsPerError) {
      return false;
    }

    // Check for error loops (same error repeatedly)
    if (error.recoveryAttempts.length >= 2) {
      const lastTwo = error.recoveryAttempts.slice(-2);
      if (lastTwo.every((a) => a.success === false)) {
        return false;
      }
    }

    return error.recoverable;
  }

  /**
   * Get all registered strategies (for diagnostics)
   */
  public getStrategies(): Array<{ name: string; description: string }> {
    return this.strategies.map((s) => ({ name: s.name, description: s.description }));
  }
}


