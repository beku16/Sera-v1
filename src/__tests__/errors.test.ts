import { describe, it, expect, beforeEach } from 'vitest';
import { ErrorMonitor, getErrorMonitor, setErrorMonitor } from '../errors/ErrorMonitor';
import { RecoveryManager } from '../errors/RecoveryManager';
import { ErrorExplainer, getNotificationLevel, buildUserNotification } from '../errors/ErrorExplainer';
import { createErrorEvent, ErrorEvent } from '../errors/types';

describe('ErrorMonitor', () => {
  let monitor: ErrorMonitor;

  beforeEach(() => {
    monitor = new ErrorMonitor({ maxHistorySize: 100, enableDeveloperMode: false });
  });

  it('should report and store errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Test error message'
    );

    monitor.reportError(error, 'TestSource');
    const recent = monitor.getRecent(10);

    expect(recent).toHaveLength(1);
    expect(recent[0].message).toBe('Test error message');
  });

  it('should track active errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Test error'
    );

    monitor.reportError(error, 'TestSource');
    let active = monitor.getActive();
    expect(active).toHaveLength(1);

    monitor.resolve(error.errorId, 'Fixed');
    active = monitor.getActive();
    expect(active).toHaveLength(0);
  });

  it('should support error subscription', () => {
    const errors: ErrorEvent[] = [];
    const unsubscribe = monitor.subscribe('browser', (error) => {
      errors.push(error);
    });

    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Browser error'
    );

    monitor.reportError(error, 'TestSource');
    expect(errors).toHaveLength(1);

    unsubscribe();
    const error2 = createErrorEvent(
      'TestSource',
      'browser',
      'Another browser error'
    );

    monitor.reportError(error2, 'TestSource');
    expect(errors).toHaveLength(1); // No new errors after unsubscribe
  });

  it('should correlate errors with tasks', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Browser error',
      {
        taskId: 'task_123',
      }
    );

    monitor.reportError(error, 'TestSource');
    const taskErrors = monitor.getTaskErrors('task_123');

    expect(taskErrors).toHaveLength(1);
    expect(taskErrors[0].errorId).toBe(error.errorId);
  });

  it('should query errors by criteria', () => {
    const error1 = createErrorEvent(
      'BrowserExecutor',
      'browser',
      'Browser error'
    );
    const error2 = createErrorEvent(
      'NetworkLayer',
      'network',
      'Network error'
    );

    monitor.reportError(error1, 'BrowserExecutor');
    monitor.reportError(error2, 'NetworkLayer');

    const browserErrors = monitor.query({ category: 'browser' });
    const networkErrors = monitor.query({ category: 'network' });

    expect(browserErrors).toHaveLength(1);
    expect(networkErrors).toHaveLength(1);
  });

  it('should enforce history size limit', () => {
    const smallMonitor = new ErrorMonitor({ maxHistorySize: 10 });

    // Add 15 errors
    for (let i = 0; i < 15; i++) {
      const error = createErrorEvent(
        'TestSource',
        'browser',
        `Error ${i}`
      );
      smallMonitor.reportError(error, 'TestSource');
    }

    const history = smallMonitor.getRecent(100);
    expect(history.length).toBeLessThanOrEqual(10);
  });

  it('should escalate errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Browser error'
    );

    monitor.reportError(error, 'TestSource');
    monitor.escalate(error.errorId, 'Requires human intervention');

    const escalated = monitor.query({ resolved: false });
    expect(escalated[0].status).toBe('escalated');
    expect(escalated[0].resolutionMessage).toBe('Requires human intervention');
  });

  it('should detect unrecovered errors by task', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Browser error',
      {
        taskId: 'task_123',
      }
    );

    monitor.reportError(error, 'TestSource');
    expect(monitor.hasUnrecoveredErrors('task_123')).toBe(true);

    monitor.resolve(error.errorId, 'Fixed');
    expect(monitor.hasUnrecoveredErrors('task_123')).toBe(false);
  });

  it('should provide critical errors', () => {
    const warning = createErrorEvent(
      'TestSource',
      'browser',
      'Warning',
      { severity: 'warning' }
    );
    const critical = createErrorEvent(
      'TestSource',
      'browser',
      'Critical error',
      { severity: 'critical' }
    );

    monitor.reportError(warning, 'TestSource');
    monitor.reportError(critical, 'TestSource');

    const criticalErrors = monitor.getCritical();
    expect(criticalErrors).toHaveLength(1);
    expect(criticalErrors[0].message).toBe('Critical error');
  });

  it('should clear all data', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Test error'
    );

    monitor.reportError(error, 'TestSource');
    expect(monitor.getRecent(10)).toHaveLength(1);

    monitor.clear();
    expect(monitor.getRecent(10)).toHaveLength(0);
    expect(monitor.getActive()).toHaveLength(0);
  });
});

describe('RecoveryManager', () => {
  let manager: RecoveryManager;
  let monitor: ErrorMonitor;

  beforeEach(() => {
    manager = new RecoveryManager();
    monitor = new ErrorMonitor();
  });

  it('should identify applicable strategies', () => {
    const error = createErrorEvent(
      'NetworkLayer',
      'network',
      'Network timeout'
    );

    const result = manager.attemptRecovery(error, monitor);
    expect(result).toBeDefined();
  });

  it('should prevent recovery of permission errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'permission',
      'Access denied',
      { recoverable: false }
    );

    expect(manager.isSafeToRecover(error)).toBe(false);
  });

  it('should prevent recovery of auth errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'authentication',
      'Auth required',
      { recoverable: false }
    );

    expect(manager.isSafeToRecover(error)).toBe(false);
  });

  it('should prevent excessive retry attempts', () => {
    const error = createErrorEvent(
      'TestSource',
      'network',
      'Network error',
      {
        recoverable: true,
      }
    );

    // Add 3 failed attempts
    error.recoveryAttempts.push({
      strategy: 'TestStrategy',
      timestamp: new Date().toISOString(),
      attempt_number: 1,
      success: false,
      message: 'Failed',
    });
    error.recoveryAttempts.push({
      strategy: 'TestStrategy',
      timestamp: new Date().toISOString(),
      attempt_number: 2,
      success: false,
      message: 'Failed',
    });
    error.recoveryAttempts.push({
      strategy: 'TestStrategy',
      timestamp: new Date().toISOString(),
      attempt_number: 3,
      success: false,
      message: 'Failed',
    });

    expect(manager.isSafeToRecover(error)).toBe(false);
  });

  it('should detect error loops', () => {
    const error = createErrorEvent(
      'TestSource',
      'network',
      'Network error',
      {
        recoverable: true,
      }
    );

    // Add 2 consecutive failed attempts
    error.recoveryAttempts.push({
      strategy: 'Retry',
      timestamp: new Date().toISOString(),
      attempt_number: 1,
      success: false,
      message: 'Failed',
    });
    error.recoveryAttempts.push({
      strategy: 'Retry',
      timestamp: new Date().toISOString(),
      attempt_number: 2,
      success: false,
      message: 'Failed',
    });

    expect(manager.isSafeToRecover(error)).toBe(false);
  });

  it('should list available strategies', () => {
    const strategies = manager.getStrategies();
    expect(strategies.length).toBeGreaterThan(0);
    expect(strategies[0]).toHaveProperty('name');
    expect(strategies[0]).toHaveProperty('description');
  });
});

describe('ErrorExplainer', () => {
  it('should explain network errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'network',
      'Connection timeout'
    );

    const explanation = ErrorExplainer.explain(error);
    expect(explanation).toBeTruthy();
    expect(explanation.toLowerCase()).toContain('internet');
  });

  it('should explain browser errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'failed to load',
      { context: { url: 'https://example.com' } }
    );

    const explanation = ErrorExplainer.explain(error);
    expect(explanation).toBeTruthy();
    expect(explanation.toLowerCase()).toContain('page');
  });

  it('should explain permission errors', () => {
    const error = createErrorEvent(
      'TestSource',
      'permission',
      'Access denied'
    );

    const explanation = ErrorExplainer.explain(error);
    expect(explanation).toBeTruthy();
    expect(explanation.toLowerCase()).toContain('permission');
  });

  it('should provide recovery messages', () => {
    const msg = ErrorExplainer.getRecoveryMessage('BrowserRefresh');
    expect(msg).toBeTruthy();
    expect(msg.toLowerCase()).toContain('refresh');
  });

  it('should provide success messages', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Page load failed',
      { recoverable: true }
    );

    error.recoveryAttempts.push({
      strategy: 'BrowserRefresh',
      timestamp: new Date().toISOString(),
      attempt_number: 1,
      success: true,
      message: 'Page refreshed',
    });

    const msg = ErrorExplainer.getRecoverySuccessMessage(error);
    expect(msg).toBeTruthy();
    expect(msg.toLowerCase()).toContain('refresh');
  });

  it('should provide failure messages', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Page load failed'
    );

    error.recoveryAttempts.push({
      strategy: 'BrowserRefresh',
      timestamp: new Date().toISOString(),
      attempt_number: 1,
      success: false,
      message: 'Refresh failed',
    });

    const msg = ErrorExplainer.getRecoveryFailureMessage(error);
    expect(msg).toBeTruthy();
  });

  it('should format errors for developer', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Browser error',
      {
        severity: 'error',
        actionId: 'action_123',
        taskId: 'task_456',
        context: {
          url: 'https://example.com',
        },
      }
    );

    const devView = ErrorExplainer.formatForDeveloper(error);
    expect(devView).toContain(error.errorId);
    expect(devView).toContain('TestSource');
    expect(devView).toContain('browser');
    expect(devView).toContain('action_123');
    expect(devView).toContain('task_456');
  });

  it('should provide correct notification levels', () => {
    const info = createErrorEvent('Test', 'browser', 'Info', { severity: 'info' });
    const warning = createErrorEvent('Test', 'browser', 'Warning', { severity: 'warning' });
    const errorRecoverable = createErrorEvent('Test', 'browser', 'Error', { severity: 'error', recoverable: true });
    const errorNotRecoverable = createErrorEvent('Test', 'browser', 'Error', { severity: 'error', recoverable: false });
    const critical = createErrorEvent('Test', 'browser', 'Critical', { severity: 'critical' });

    expect(getNotificationLevel(info)).toBe('info');
    expect(getNotificationLevel(warning)).toBe('warning');
    expect(getNotificationLevel(errorRecoverable)).toBe('alert');
    expect(getNotificationLevel(errorNotRecoverable)).toBe('critical');
    expect(getNotificationLevel(critical)).toBe('critical');
  });

  it('should build complete user notifications', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Page load failed'
    );

    const notification = buildUserNotification(error);
    expect(notification).toBeTruthy();
    expect(notification).toContain('page');
  });
});

describe('Error Event Factory', () => {
  it('should create error events with all fields', () => {
    const error = createErrorEvent(
      'TestSource',
      'browser',
      'Test message',
      {
        severity: 'error',
        recoverable: true,
        context: { url: 'https://example.com' },
      }
    );

    expect(error.source).toBe('TestSource');
    expect(error.category).toBe('browser');
    expect(error.message).toBe('Test message');
    expect(error.severity).toBe('error');
    expect(error.recoverable).toBe(true);
    expect(error.errorId).toBeTruthy();
    expect(error.timestamp).toBeTruthy();
    expect(error.recoveryAttempts).toEqual([]);
  });

  it('should handle optional fields', () => {
    const error = createErrorEvent(
      'TestSource',
      'network',
      'Network error'
    );

    expect(error.severity).toBe('error'); // Default
    expect(error.recoverable).toBe(false); // Default false, can be enabled via option
    expect(error.recoveryAttempts).toEqual([]);
  });
});
