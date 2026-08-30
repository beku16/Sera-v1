import { describe, expect, it } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ApplicationExecutor, ApplicationProcessController } from '../actions/ApplicationExecutor';
import { closeApplicationTool } from '../tools/tools/applicationControlTools';
import { ToolPermissionLevel } from '../tools/types';

class MockProcessController implements ApplicationProcessController {
  terminated: number[] = [];
  running = new Set<number>([4321]);
  async terminate(processId: number): Promise<boolean> { this.terminated.push(processId); this.running.delete(processId); return true; }
  async isRunning(processId: number): Promise<boolean> { return this.running.has(processId); }
}

describe('application force close', () => {
  it('terminates and verifies a target process', async () => {
    const processes = new MockProcessController();
    const manager = new ActionManager();
    manager.registerExecutor(new ApplicationExecutor([], undefined, 'win32', undefined, processes));
    const action = manager.createAction({ type: 'application.close', parameters: { processId: 4321 } });

    const result = await manager.execute(action);

    expect(result.status).toBe('succeeded');
    expect(processes.terminated).toEqual([4321]);
    expect(result.result).toMatchObject({ processId: 4321, terminated: true });
  });

  it('rejects attempts to terminate the current process', async () => {
    const processes = new MockProcessController();
    const manager = new ActionManager();
    manager.registerExecutor(new ApplicationExecutor([], undefined, 'win32', undefined, processes));
    const action = manager.createAction({ type: 'application.close', parameters: { processId: process.pid } });

    const result = await manager.execute(action);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
    expect(processes.terminated).toHaveLength(0);
  });

  it('exposes force close as a dangerous authorized operation', () => {
    expect(closeApplicationTool.permissionLevel).toBe(ToolPermissionLevel.DANGEROUS_ACTION);
    expect(closeApplicationTool.capability).toBe('APPLICATION_CLOSE');
    expect(closeApplicationTool.validateArgs({ processId: 4321 }).valid).toBe(true);
    expect(closeApplicationTool.validateArgs({}).valid).toBe(false);
  });
});
