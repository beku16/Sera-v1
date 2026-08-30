/**
 * Error Event Model
 * Normalized structure for all observable failures across SERA systems
 */

export type ErrorCategory = 
  | 'network'
  | 'browser'
  | 'application'
  | 'system'
  | 'input'
  | 'screen'
  | 'vision'
  | 'memory'
  | 'tool'
  | 'authentication'
  | 'permission'
  | 'timeout'
  | 'unknown';

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export type RecoveryLevel = 'none' | 'automatic' | 'limited' | 'requires_human';

export interface ErrorContext {
  taskId?: string;
  actionId?: string;
  application?: string;
  window?: { title?: string; handle?: string };
  url?: string;
  operation?: string;
  screen?: { width?: number; height?: number; screenshot?: boolean };
  previous_action?: string;
  [key: string]: unknown;
}

export interface RecoveryAttempt {
  strategy: string;
  timestamp: string;
  attempt_number: number;
  success: boolean;
  message?: string;
  error?: string;
}

export interface ErrorEvent {
  // Identification
  errorId: string;
  timestamp: string;

  // Classification
  source: string; // e.g., 'BrowserExecutor', 'ActionManager', 'WebSocket'
  category: ErrorCategory;
  severity: ErrorSeverity;

  // Description
  message: string; // User-friendly explanation
  technicalMessage?: string; // Raw error details
  code?: string; // Error code if applicable

  // Correlation
  context: ErrorContext;

  // Recovery
  recoverable: boolean;
  recoveryLevel: RecoveryLevel;
  suggestedRecovery?: string;
  recoveryAttempts: RecoveryAttempt[];
  lastRecoveryStatus?: 'pending' | 'in_progress' | 'succeeded' | 'failed';

  // Status
  status: 'reported' | 'acknowledged' | 'recovered' | 'escalated' | 'ignored';
  resolvedAt?: string;
  resolutionMessage?: string;
}

export interface ErrorReport {
  error: ErrorEvent;
  detectedBy: string;
  timestamp: string;
}

/**
 * Structured error creation helper
 */
export function createErrorEvent(
  source: string,
  category: ErrorCategory,
  message: string,
  options?: {
    severity?: ErrorSeverity;
    taskId?: string;
    actionId?: string;
    technicalMessage?: string;
    code?: string;
    context?: Partial<ErrorContext>;
    recoverable?: boolean;
    suggestedRecovery?: string;
  }
): ErrorEvent {
  return {
    errorId: `err_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
    source,
    category,
    message,
    technicalMessage: options?.technicalMessage,
    code: options?.code,
    severity: options?.severity ?? 'error',
    context: {
      taskId: options?.taskId,
      actionId: options?.actionId,
      ...options?.context,
    },
    recoverable: options?.recoverable ?? false,
    recoveryLevel: options?.recoverable ? 'limited' : 'none',
    suggestedRecovery: options?.suggestedRecovery,
    recoveryAttempts: [],
    status: 'reported',
  };
}

/**
 * Error that is observable but not necessarily a failure
 */
export function createInfoEvent(
  source: string,
  message: string,
  context?: ErrorContext
): ErrorEvent {
  return {
    errorId: `info_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
    source,
    category: 'unknown',
    message,
    severity: 'info',
    context: context ?? {},
    recoverable: false,
    recoveryLevel: 'none',
    recoveryAttempts: [],
    status: 'reported',
  };
}
