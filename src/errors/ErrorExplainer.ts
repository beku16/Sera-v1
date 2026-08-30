import { ErrorEvent, ErrorCategory, ErrorSeverity } from './types';

/**
 * Translates technical errors into user-friendly explanations
 */
export class ErrorExplainer {
  /**
   * Get a simple, non-technical explanation for an error
   */
  static explain(error: ErrorEvent): string {
    // Category-based explanations
    switch (error.category) {
      case 'network':
        return this.explainNetwork(error);
      case 'browser':
        return this.explainBrowser(error);
      case 'application':
        return this.explainApplication(error);
      case 'permission':
        return this.explainPermission(error);
      case 'timeout':
        return this.explainTimeout(error);
      case 'authentication':
        return this.explainAuthentication(error);
      default:
        return error.message || 'Something went wrong.';
    }
  }

  private static explainNetwork(error: ErrorEvent): string {
    if (error.message.includes('offline') || error.message.includes('unavailable')) {
      return "Internet connection is currently unavailable. Local actions will continue, but online features won't work.";
    }
    if (error.message.includes('timeout')) {
      return 'The request took too long to complete. Check your internet connection.';
    }
    if (error.message.includes('ECONNREFUSED')) {
      return 'Cannot connect to the service. The connection was refused.';
    }
    return 'A network error occurred. Check your internet connection.';
  }

  private static explainBrowser(error: ErrorEvent): string {
    if (error.message.includes('navigation') || error.message.includes('failed to load')) {
      return `The browser couldn't load the page at ${error.context.url || 'the URL'}. Check the address or try again.`;
    }
    if (error.message.includes('element') && error.message.includes('not found')) {
      return `The page changed and I couldn't find the target element. The website might have updated.`;
    }
    if (error.message.includes('popup') || error.message.includes('blocked')) {
      return 'The browser blocked a popup or dialog that the action needed. This might be a security feature.';
    }
    if (error.message.includes('crash')) {
      return 'The browser page crashed. I can try opening it again.';
    }
    return 'A browser error occurred. The page might be unavailable or changed.';
  }

  private static explainApplication(error: ErrorEvent): string {
    if (error.message.includes('launch') || error.message.includes('start')) {
      return `${error.context.application || 'The application'} didn't start. Windows might be blocking it or it's not installed.`;
    }
    if (error.message.includes('close') || error.message.includes('disappeared')) {
      return `${error.context.application || 'The application'} closed or stopped responding during the action.`;
    }
    if (error.message.includes('focus')) {
      return `${error.context.application || 'The application'} lost focus. Windows might have switched to another window.`;
    }
    return `${error.context.application || 'The application'} encountered an error.`;
  }

  private static explainPermission(error: ErrorEvent): string {
    return `Windows denied this action because Sera doesn't have the required permission. An administrator might need to grant access.`;
  }

  private static explainTimeout(error: ErrorEvent): string {
    if (error.context.operation) {
      return `The operation (${error.context.operation}) took too long. The system might be slow or unresponsive.`;
    }
    return 'The operation took too long and timed out.';
  }

  private static explainAuthentication(error: ErrorEvent): string {
    return 'Authentication failed. Check your credentials or login status.';
  }

  /**
   * Get a brief status message for recovery in progress
   */
  static getRecoveryMessage(strategyName: string): string {
    const messages: Record<string, string> = {
      BrowserRetry: 'Retrying the browser action...',
      BrowserRefresh: 'Refreshing the browser page...',
      WebSocketReconnect: 'Reconnecting to the service...',
      WindowRefocus: 'Refocusing the window...',
      NetworkWaitRetry: 'Waiting for network recovery...',
    };
    return messages[strategyName] || 'Attempting recovery...';
  }

  /**
   * Get a message confirming successful recovery
   */
  static getRecoverySuccessMessage(error: ErrorEvent): string {
    if (error.recoveryAttempts.length === 0) {
      return 'The issue was automatically resolved.';
    }

    const lastAttempt = error.recoveryAttempts[error.recoveryAttempts.length - 1];
    const strategy = lastAttempt.strategy;

    const messages: Record<string, string> = {
      BrowserRetry: 'I retried the action and it worked.',
      BrowserRefresh: 'I refreshed the page and it loaded successfully.',
      WebSocketReconnect: 'I reconnected to the service and continued.',
      WindowRefocus: 'I refocused the window and continued.',
      NetworkWaitRetry: 'The connection recovered and I continued.',
    };

    return messages[strategy] || 'The issue was automatically recovered.';
  }

  /**
   * Get a message explaining why recovery failed
   */
  static getRecoveryFailureMessage(error: ErrorEvent): string {
    if (error.recoveryAttempts.length >= 3) {
      return "I tried recovering multiple times, but the issue persists. It might require manual intervention.";
    }

    if (error.category === 'permission') {
      return "This requires user permission or authorization. I can't fix it automatically.";
    }

    if (error.category === 'authentication') {
      return 'Authentication is required. Please log in again.';
    }

    const lastAttempt = error.recoveryAttempts[error.recoveryAttempts.length - 1];
    if (lastAttempt) {
      return `I tried ${lastAttempt.strategy} but it didn't work. ${error.message}`;
    }

    return `I couldn't automatically recover from this issue: ${error.message}`;
  }

  /**
   * Format error for developer diagnostics panel
   */
  static formatForDeveloper(error: ErrorEvent): string {
    const lines = [
      `ID: ${error.errorId}`,
      `Timestamp: ${error.timestamp}`,
      `Source: ${error.source}`,
      `Category: ${error.category}`,
      `Severity: ${error.severity}`,
      `Message: ${error.message}`,
      error.technicalMessage ? `Technical: ${error.technicalMessage}` : null,
      error.code ? `Code: ${error.code}` : null,
      error.context.taskId ? `Task: ${error.context.taskId}` : null,
      error.context.actionId ? `Action: ${error.context.actionId}` : null,
      error.context.url ? `URL: ${error.context.url}` : null,
      error.recoveryAttempts.length > 0 ? `Recovery Attempts: ${error.recoveryAttempts.length}` : null,
      error.status ? `Status: ${error.status}` : null,
    ];

    return lines.filter((line): line is string => line !== null).join('\n');
  }
}

/**
 * Determine notification level for user
 */
export function getNotificationLevel(error: ErrorEvent): 'info' | 'warning' | 'alert' | 'critical' {
  if (error.severity === 'critical') return 'critical';
  if (error.severity === 'error') return error.recoverable ? 'alert' : 'critical';
  if (error.severity === 'warning') return 'warning';
  return 'info';
}

/**
 * Build a complete user notification
 */
export function buildUserNotification(error: ErrorEvent, recovery?: { success: boolean; message: string }): string {
  const explanation = ErrorExplainer.explain(error);

  if (recovery) {
    if (recovery.success) {
      const successMsg = ErrorExplainer.getRecoverySuccessMessage(error);
      return `${explanation} ${successMsg}`;
    } else {
      const failureMsg = ErrorExplainer.getRecoveryFailureMessage(error);
      return `${explanation} ${failureMsg}`;
    }
  }

  return explanation;
}
