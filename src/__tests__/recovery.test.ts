import { describe, expect, it } from 'vitest';
import { ErrorMonitor } from '../errors/ErrorMonitor';
import { RecoveryManager } from '../errors/RecoveryManager';
import { createErrorEvent } from '../errors/types';

describe('WebSocket recovery strategy', () => {
  it('uses the supplied reconnect callback and reports success', async () => {
    const manager = new RecoveryManager();
    const monitor = new ErrorMonitor();
    const error = createErrorEvent('WebSocket', 'network', 'Connection lost');
    const reconnect = async () => true;

    const result = await manager.attemptRecovery(error, monitor, { reconnect });

    expect(result).toMatchObject({ success: true, nextAction: 'continue' });
    expect(error.recoveryAttempts[0]).toMatchObject({ strategy: 'WebSocketReconnect', success: true });
  });

  it('fails clearly when no reconnect callback is supplied', async () => {
    const manager = new RecoveryManager();
    const monitor = new ErrorMonitor();
    const error = createErrorEvent('WebSocket', 'network', 'Connection lost');

    const result = await manager.attemptRecovery(error, monitor);

    expect(result.success).toBe(true);
    expect(error.recoveryAttempts[0]).toMatchObject({ strategy: 'WebSocketReconnect', success: false, message: 'WebSocket reconnect strategy requires a reconnect callback' });
  });
});
describe('Window refocus recovery strategy', () => {
  it('uses the supplied refocus callback and reports success', async () => {
    const manager = new RecoveryManager();
    const monitor = new ErrorMonitor();
    const error = createErrorEvent('InputExecutor', 'input', 'Target window lost focus');

    const result = await manager.attemptRecovery(error, monitor, { refocus: () => true });

    expect(result).toMatchObject({ success: true, nextAction: 'continue' });
    expect(error.recoveryAttempts[0]).toMatchObject({ strategy: 'WindowRefocus', success: true });
  });

  it('reports missing refocus integration without claiming recovery', async () => {
    const manager = new RecoveryManager();
    const monitor = new ErrorMonitor();
    const error = createErrorEvent('InputExecutor', 'input', 'Target window lost focus');

    const result = await manager.attemptRecovery(error, monitor);

    expect(error.recoveryAttempts[0]).toMatchObject({ strategy: 'WindowRefocus', success: false });
    expect(result.success).toBe(false);
  });
});
