import { ErrorEvent, RecoveryLevel } from './types';

export interface ErrorMonitorOptions {
  maxHistorySize?: number;
  enableDeveloperMode?: boolean;
}

export interface ErrorListener {
  (error: ErrorEvent): void;
}

export interface ErrorQuery {
  source?: string;
  category?: string;
  severity?: string;
  taskId?: string;
  actionId?: string;
  resolved?: boolean;
}

/**
 * Centralized error monitoring and management service
 * Receives observable failures from all SERA systems
 */
export class ErrorMonitor {
  private history: Map<string, ErrorEvent> = new Map();
  private listeners: Map<string, Set<ErrorListener>> = new Map();
  private maxHistorySize: number;
  private developerMode: boolean;
  private activeErrors: Map<string, ErrorEvent> = new Map(); // Unresolved errors
  private errorsByTask: Map<string, Set<string>> = new Map(); // Task → error IDs

  constructor(options?: ErrorMonitorOptions) {
    this.maxHistorySize = options?.maxHistorySize ?? 500;
    this.developerMode = options?.enableDeveloperMode ?? false;
  }

  /**
   * Report an error to the monitor
   */
  public reportError(error: ErrorEvent, source: string): void {
    // Store in history
    this.history.set(error.errorId, { ...error });

    // Track as active
    if (error.status !== 'recovered' && error.status !== 'ignored') {
      this.activeErrors.set(error.errorId, error);
    }

    // Correlate with task if present
    if (error.context.taskId) {
      if (!this.errorsByTask.has(error.context.taskId)) {
        this.errorsByTask.set(error.context.taskId, new Set());
      }
      this.errorsByTask.get(error.context.taskId)!.add(error.errorId);
    }

    // Enforce history size limit
    if (this.history.size > this.maxHistorySize) {
      const oldest = Array.from(this.history.entries())
        .sort((a, b) => new Date(a[1].timestamp).getTime() - new Date(b[1].timestamp).getTime())
        .slice(0, Math.floor(this.maxHistorySize * 0.1))
        .map((e) => e[0]);
      oldest.forEach((id) => this.history.delete(id));
    }

    // Notify listeners
    this.notifyListeners(error.category, error);
    if (error.severity === 'critical') {
      this.notifyListeners('critical', error);
    }

    // Log if developer mode
    if (this.developerMode) {
      console.log(`[ErrorMonitor] ${error.source}/${error.category}: ${error.message}`, error);
    }
  }

  /**
   * Subscribe to errors of a specific category
   */
  public subscribe(category: string, listener: ErrorListener): () => void {
    if (!this.listeners.has(category)) {
      this.listeners.set(category, new Set());
    }
    this.listeners.get(category)!.add(listener);

    // Return unsubscribe function
    return () => {
      this.listeners.get(category)?.delete(listener);
    };
  }

  /**
   * Get errors by query
   */
  public query(q: ErrorQuery): ErrorEvent[] {
    return Array.from(this.history.values()).filter((error) => {
      if (q.source && error.source !== q.source) return false;
      if (q.category && error.category !== q.category) return false;
      if (q.severity && error.severity !== q.severity) return false;
      if (q.taskId && error.context.taskId !== q.taskId) return false;
      if (q.actionId && error.context.actionId !== q.actionId) return false;
      if (q.resolved !== undefined) {
        const isResolved = error.resolvedAt !== undefined;
        if (q.resolved !== isResolved) return false;
      }
      return true;
    });
  }

  /**
   * Get errors related to a specific task
   */
  public getTaskErrors(taskId: string): ErrorEvent[] {
    const errorIds = this.errorsByTask.get(taskId) || new Set();
    return Array.from(errorIds)
      .map((id) => this.history.get(id))
      .filter((e): e is ErrorEvent => e !== undefined);
  }

  /**
   * Get recent errors (last N)
   */
  public getRecent(limit: number = 20): ErrorEvent[] {
    return Array.from(this.history.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }

  /**
   * Get active (unresolved) errors
   */
  public getActive(): ErrorEvent[] {
    return Array.from(this.activeErrors.values());
  }

  /**
   * Mark error as resolved
   */
  public resolve(errorId: string, message: string): void {
    const error = this.history.get(errorId);
    if (error) {
      error.status = 'recovered';
      error.resolvedAt = new Date().toISOString();
      error.resolutionMessage = message;
      this.activeErrors.delete(errorId);
    }
  }

  /**
   * Mark error as escalated (requires human attention)
   */
  public escalate(errorId: string, reason: string): void {
    const error = this.history.get(errorId);
    if (error) {
      error.status = 'escalated';
      error.resolutionMessage = reason;
      this.activeErrors.set(errorId, error);
    }
  }

  /**
   * Get all errors for developer diagnostics
   */
  public getDeveloperDiagnostics(limit: number = 100): ErrorEvent[] {
    return this.getRecent(limit);
  }

  /**
   * Get critical errors (for alert system)
   */
  public getCritical(): ErrorEvent[] {
    return this.query({ severity: 'critical', resolved: false });
  }

  /**
   * Check if there are unrecovered errors for a task
   */
  public hasUnrecoveredErrors(taskId: string): boolean {
    return this.getTaskErrors(taskId).some((e) => e.status !== 'recovered' && e.status !== 'ignored');
  }

  /**
   * Clear history (for testing)
   */
  public clear(): void {
    this.history.clear();
    this.activeErrors.clear();
    this.errorsByTask.clear();
    this.listeners.clear();
  }

  private notifyListeners(category: string, error: ErrorEvent): void {
    const listeners = this.listeners.get(category);
    if (listeners) {
      listeners.forEach((listener) => {
        try {
          listener(error);
        } catch (cause) {
          console.error('Error in ErrorMonitor listener:', cause);
        }
      });
    }
  }
}

// Singleton instance
let globalErrorMonitor: ErrorMonitor | null = null;

export function getErrorMonitor(options?: ErrorMonitorOptions): ErrorMonitor {
  if (!globalErrorMonitor) {
    globalErrorMonitor = new ErrorMonitor(options);
  }
  return globalErrorMonitor;
}

export function setErrorMonitor(monitor: ErrorMonitor): void {
  globalErrorMonitor = monitor;
}
