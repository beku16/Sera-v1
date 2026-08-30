import { describe, expect, it, vi } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ApplicationExecutor, ApplicationLaunchHandle } from '../actions/ApplicationExecutor';
import { ACTION_ERROR_CODES } from '../actions/errors';
import { InputController, ScreenController } from '../actions/ControlProviders';
import { InputExecutor } from '../actions/InputExecutor';
import { ScreenExecutor } from '../actions/ScreenExecutor';
import { WindowExecutor, WindowInfo, WindowControlProvider } from '../actions/WindowExecutor';
import { ActionExecutionContext, ActionExecutor } from '../actions/types';
import { ToolManager } from '../tools/ToolManager';
import { computerInputTool } from '../tools/tools/computerControlTools';
import { ComputerAuthorizationManager } from '../authorization/ComputerAuthorizationManager';

function context(): ActionExecutionContext {
  return { signal: new AbortController().signal, log: vi.fn() };
}

function runningHandle(pid = 1234): ApplicationLaunchHandle {
  return { pid, process: { exitCode: null, killed: false, kill: vi.fn() } };
}

describe('ActionManager', () => {
  it('creates actions with task and action IDs and queues them', () => {
    const manager = new ActionManager({ idFactory: (() => { let count = 0; return () => `id-${++count}`; })() });
    const action = manager.createAction({ type: 'test.action', parameters: {} });

    expect(action.taskId).toBe('id-1');
    expect(action.actionId).toBe('id-2');
    expect(action.status).toBe('queued');
    expect(manager.getAction(action.actionId)).toBe(action);
  });

  it('dispatches once and returns the existing result for duplicate action delivery', async () => {
    const manager = new ActionManager();
    const execute = vi.fn(async () => ({ result: { ok: true }, verification: { status: 'success' as const } }));
    const executor: ActionExecutor = {
      name: 'TestExecutor',
      canHandle: (action) => action.type === 'test.action',
      execute,
      verify: vi.fn(async () => ({ status: 'success' as const })),
    };
    manager.registerExecutor(executor);
    const action = manager.createAction({ type: 'test.action', parameters: {} });

    const [first, second] = await Promise.all([manager.execute(action), manager.execute(action)]);

    expect(first).toEqual(second);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('succeeded');
  });

  it('does not replace the stored action when an existing action ID is recreated', () => {
    const manager = new ActionManager();
    const first = manager.createAction({ actionId: 'fixed-action', type: 'test.action', parameters: { value: 1 } });
    const duplicate = manager.createAction({ actionId: 'fixed-action', type: 'test.action', parameters: { value: 2 } });

    expect(duplicate).toBe(first);
    expect(manager.getAction('fixed-action')).toBe(first);
  });

  it('requires successful verification before succeeding', async () => {
    const manager = new ActionManager();
    manager.registerExecutor({
      name: 'FailingVerifier',
      canHandle: () => true,
      execute: async () => ({ result: { completed: true } }),
      verify: async () => ({ status: 'failure' as const, message: 'Target was not found.' }),
    });
    const action = await manager.execute(manager.createAction({ type: 'test.action', parameters: {} }));

    expect(action.status).toBe('failed');
    expect(action.error?.code).toBe(ACTION_ERROR_CODES.VERIFICATION_FAILED);
    expect(action.verification?.status).toBe('failure');
  });

  it('cancels a queued action and notifies its executor', async () => {
    const manager = new ActionManager();
    const cancel = vi.fn();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    manager.registerExecutor({
      name: 'CancellableExecutor',
      canHandle: () => true,
      execute: async () => { await pending; return {}; },
      verify: async () => ({ status: 'success' as const }),
      cancel,
    });
    const action = manager.createAction({ type: 'test.action', parameters: {} });
    const execution = manager.execute(action);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await manager.cancel(action.actionId)).toBe(true);
    release();
    expect((await execution).status).toBe('cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('returns a structured unsupported-action failure', async () => {
    const manager = new ActionManager();
    const action = await manager.execute(manager.createAction({ type: 'unknown.action', parameters: {} }));

    expect(action.status).toBe('failed');
    expect(action.error?.code).toBe(ACTION_ERROR_CODES.ACTION_NOT_SUPPORTED);
  });
});

describe('ApplicationExecutor', () => {
  it('launches a catalog application and verifies its process', async () => {
    const launcher = vi.fn(async () => runningHandle(4321));
    const executor = new ApplicationExecutor(undefined, launcher, 'win32', async () => ({ ready: true }));
    const manager = new ActionManager();
    manager.registerExecutor(executor);
    const action = await manager.execute(manager.createAction({
      type: 'application.launch',
      parameters: { application: 'Calculator' },
    }));

    expect(action.status).toBe('succeeded');
    expect(action.result).toMatchObject({ application: 'calculator', displayName: 'Calculator', pid: 4321 });
    expect(launcher).toHaveBeenCalledWith(expect.objectContaining({ executable: 'calc.exe' }));
  });

  it('rejects applications outside the safe catalog', async () => {
    const executor = new ApplicationExecutor(undefined, vi.fn(), 'win32');
    const manager = new ActionManager();
    manager.registerExecutor(executor);
    const action = await manager.execute(manager.createAction({
      type: 'application.launch',
      parameters: { application: 'definitely-not-installed-sera-test' },
    }));

    expect(action.status).toBe('failed');
    expect(action.error?.code).toBe(ACTION_ERROR_CODES.APPLICATION_NOT_FOUND);
  }, 15000);

  it('fails launch when the native window never becomes ready', async () => {
    const executor = new ApplicationExecutor(undefined, vi.fn(async () => runningHandle()), 'win32', async () => undefined);
    const manager = new ActionManager();
    manager.registerExecutor(executor);
    const action = await manager.execute(manager.createAction({ type: 'application.launch', parameters: { application: 'Notepad' } }));

    expect(action.status).toBe('failed');
    expect(action.error?.message).toContain('window did not become ready');
  });
});

describe('Phase 1 control executors', () => {
  it('dispatches input and requires provider verification', async () => {
    const controller: InputController = {
      type: vi.fn(), press: vi.fn(), hotkey: vi.fn(), click: vi.fn(), move: vi.fn(), scroll: vi.fn(), drag: vi.fn(),
      verify: vi.fn(async () => ({ status: 'success' as const, message: 'Input observed.' })),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new InputExecutor(controller));
    const action = await manager.execute(manager.createAction({ type: 'input.hotkey', parameters: { keys: ['CTRL', 'C'] } }));

    expect(action.status).toBe('succeeded');
    expect(controller.hotkey).toHaveBeenCalledWith(['ctrl', 'c']);
  });

  it('rejects malformed input before invoking the provider', async () => {
    const controller: InputController = {
      type: vi.fn(), press: vi.fn(), hotkey: vi.fn(), click: vi.fn(), move: vi.fn(), scroll: vi.fn(), drag: vi.fn(), verify: vi.fn(),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new InputExecutor(controller));
    const action = await manager.execute(manager.createAction({ type: 'input.move', parameters: { x: '10', y: 20 } }));

    expect(action.status).toBe('failed');
    expect(action.error?.code).toBe(ACTION_ERROR_CODES.INVALID_ARGUMENT);
    expect(controller.move).not.toHaveBeenCalled();
  });

  it('rejects unrecognized keys before invoking the provider', async () => {
    const controller: InputController = {
      type: vi.fn(), press: vi.fn(), hotkey: vi.fn(), click: vi.fn(), move: vi.fn(), scroll: vi.fn(), drag: vi.fn(), verify: vi.fn(),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new InputExecutor(controller));
    const action = await manager.execute(manager.createAction({ type: 'input.press', parameters: { key: 'launch-missiles' } }));

    expect(action.status).toBe('failed');
    expect(action.error?.code).toBe(ACTION_ERROR_CODES.INVALID_KEY);
    expect(controller.press).not.toHaveBeenCalled();
  });

  it('tracks explicit screen sharing state and inspection', async () => {
    let sharing = false;
    const controller: ScreenController = {
      startSharing: vi.fn(async () => { sharing = true; }),
      stopSharing: vi.fn(async () => { sharing = false; }),
      isSharing: () => sharing,
      capture: vi.fn(async () => ({ width: 100, height: 100, capturedAt: '2026-01-01T00:00:00.000Z', data: 'AQID' })),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenExecutor(controller));
    const start = await manager.execute(manager.createAction({ type: 'screen.startSharing', parameters: {} }));
    const inspect = await manager.execute(manager.createAction({ type: 'screen.inspect', parameters: {} }));

    expect(start.status).toBe('succeeded');
    expect(inspect.status).toBe('succeeded');
    expect(controller.capture).toHaveBeenCalledTimes(1);
  });

  it('refreshes a stale cached screen state via a fresh capture instead of returning it as current', async () => {
    const staleFrame = { width: 100, height: 100, capturedAt: new Date(Date.now() - 1000).toISOString(), data: 'AQID' };
    const freshFrame = { width: 100, height: 100, capturedAt: new Date().toISOString(), data: 'AAEC' };
    let captureCallCount = 0;
    const controller: ScreenController = {
      startSharing: vi.fn(async () => undefined),
      stopSharing: vi.fn(async () => undefined),
      // Auto-start sharing if it isn't active — ScreenExecutor's new
      // behaviour starts sharing on the first inspect call so the
      // continuous-capture timer runs and `getLatestFrame()` is populated.
      isSharing: () => false,
      getLatestFrame: () => staleFrame,
      capture: vi.fn(async () => {
        captureCallCount += 1;
        return freshFrame;
      }),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenExecutor(controller));
    const action = await manager.execute(manager.createAction({ type: 'screen.inspect', parameters: {} }));

    // After the fix: stale cached frame triggers a fresh capture rather
    // than throwing SCREEN_STATE_STALE. The user gets a usable frame,
    // not an error.
    expect(action.status).toBe('succeeded');
    expect(controller.capture).toHaveBeenCalled();
    // startSharing is auto-invoked because isSharing() returned false.
    expect(controller.startSharing).toHaveBeenCalled();
    expect(action.result).toEqual(freshFrame);
  });

  it('returns a fresh cached frame without re-capturing when the cache is younger than 500ms', async () => {
    const freshCachedFrame = { width: 100, height: 100, capturedAt: new Date().toISOString(), data: 'AQID' };
    const controller: ScreenController = {
      startSharing: vi.fn(async () => undefined),
      stopSharing: vi.fn(async () => undefined),
      isSharing: () => true,
      getLatestFrame: () => freshCachedFrame,
      capture: vi.fn(async () => freshCachedFrame),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenExecutor(controller));
    const action = await manager.execute(manager.createAction({ type: 'screen.inspect', parameters: {} }));

    expect(action.status).toBe('succeeded');
    expect(controller.capture).not.toHaveBeenCalled();
    expect(action.result).toEqual(freshCachedFrame);
  });

  it('allows sensitive input only during an authorized control session', async () => {
    const controller: InputController = {
      type: vi.fn(), press: vi.fn(), hotkey: vi.fn(), click: vi.fn(), move: vi.fn(), scroll: vi.fn(), drag: vi.fn(), verify: vi.fn(async () => ({ status: 'inconclusive' as const, message: 'Input executed.' })),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new InputExecutor(controller));
    const authorization = new ComputerAuthorizationManager();
    const tools = new ToolManager(manager, authorization);
    tools.registerTool(computerInputTool);

    // Without authorization, tool should reject
    expect((await tools.executeTool('controlComputerInput', { operation: 'press', key: 'enter' })).success).toBe(false);
    // Authorization permits execution, but missing observation prevents a success result.
    authorization.setAuthorizationMode('TRUSTED');
    expect((await tools.executeTool('controlComputerInput', { operation: 'press', key: 'enter' })).success).toBe(false);
    authorization.setAuthorizationMode('STANDARD');
    // After revocation, tool should reject again
    expect((await tools.executeTool('controlComputerInput', { operation: 'press', key: 'enter' })).success).toBe(false);
  });

  it('focuses and verifies a window through WindowExecutor', async () => {
    const target: WindowInfo = { handle: '42', application: 'Calculator', title: 'Calculator', processId: 42, processPath: 'calc.exe', bounds: { x: 0, y: 0, width: 300, height: 300 }, visible: true };
    let foreground = '1';
    const provider: WindowControlProvider = {
      getActive: async () => target,
      list: async () => [target],
      focus: async () => { foreground = target.handle; return true; },
      getForegroundHandle: async () => foreground,
    };
    const manager = new ActionManager();
    manager.registerExecutor(new WindowExecutor(provider));
    const action = await manager.execute(manager.createAction({ type: 'window.focus', parameters: { application: 'Calculator' } }));

    expect(action.status).toBe('succeeded');
    expect(action.verification?.status).toBe('success');
  });

  it('returns FOCUS_FAILED when the foreground window remains different', async () => {
    const target: WindowInfo = { handle: '42', application: 'Calculator', title: 'Calculator', processId: 42, processPath: 'calc.exe', bounds: { x: 0, y: 0, width: 300, height: 300 }, visible: true };
    const provider: WindowControlProvider = {
      getActive: async () => target,
      list: async () => [target],
      focus: async () => false,
      getForegroundHandle: async () => '1',
    };
    const manager = new ActionManager();
    manager.registerExecutor(new WindowExecutor(provider));
    const action = await manager.execute(manager.createAction({ type: 'window.focus', parameters: { handle: '42' } }));

    expect(action.status).toBe('failed');
    expect(action.error?.code).toBe('FOCUS_FAILED');
  });

  it('minimizes, maximizes, and restores a window with state verification', async () => {
    let state: 'minimized' | 'maximized' | 'normal' = 'normal';
    const target: WindowInfo = { handle: '42', application: 'Notepad', title: 'Untitled - Notepad', processId: 42, processPath: 'notepad.exe', bounds: { x: 0, y: 0, width: 300, height: 300 }, visible: true };
    const provider: WindowControlProvider = {
      getActive: async () => target,
      list: async () => [target],
      focus: async () => true,
      getForegroundHandle: async () => target.handle,
      setState: async (_window, requested) => { state = requested === 'restored' ? 'normal' : requested; return true; },
      getState: async () => state,
    };
    const manager = new ActionManager();
    manager.registerExecutor(new WindowExecutor(provider));

    for (const operation of ['minimize', 'maximize', 'restore'] as const) {
      const action = await manager.execute(manager.createAction({ type: `window.${operation}`, parameters: { handle: target.handle } }));
      expect(action.status).toBe('succeeded');
      expect(action.verification?.status).toBe('success');
    }
  });

  it('closes a window only after disappearance verification', async () => {
    const target: WindowInfo = { handle: '42', application: 'Notepad', title: 'Untitled - Notepad', processId: 42, processPath: 'notepad.exe', bounds: { x: 0, y: 0, width: 300, height: 300 }, visible: true };
    let present = true;
    const provider: WindowControlProvider = {
      getActive: async () => present ? target : undefined,
      list: async () => present ? [target] : [],
      focus: async () => true,
      getForegroundHandle: async () => target.handle,
      close: async () => { present = false; return true; },
    };
    const manager = new ActionManager();
    manager.registerExecutor(new WindowExecutor(provider));
    const action = await manager.execute(manager.createAction({ type: 'window.close', parameters: { handle: target.handle } }));

    expect(action.status).toBe('succeeded');
    expect(action.verification?.status).toBe('success');
    expect(present).toBe(false);
  });

  it('requires an observer to verify input state changes', async () => {
    let observed = 0;
    const controller: InputController = {
      type: vi.fn(), press: vi.fn(), hotkey: vi.fn(), click: vi.fn(), move: vi.fn(), scroll: vi.fn(), drag: vi.fn(),
      verify: vi.fn(async () => ({ status: 'failure' as const, message: 'No observer.' })),
    };
    const manager = new ActionManager();
    manager.registerExecutor(new InputExecutor(controller, undefined, {
      observe: async () => ++observed,
      verify: async (_action, before, after) => after === (before as number) + 1 ? { status: 'success' as const } : { status: 'failure' as const },
    }));
    const action = await manager.execute(manager.createAction({ type: 'input.type', parameters: { text: 'verified' } }));

    expect(action.status).toBe('succeeded');
    expect(action.verification?.status).toBe('success');
    expect(observed).toBe(2);
  });

  it('rejects a stale handle even when a different matching window is active', async () => {
    const active: WindowInfo = { handle: 'fresh', application: 'Calculator', title: 'Calculator', processId: 2, processPath: 'calc.exe', bounds: { x: 0, y: 0, width: 300, height: 300 }, visible: true };
    const stale: WindowInfo = { ...active, handle: 'stale', processId: 1 };
    const provider: WindowControlProvider = {
      getActive: async () => active,
      list: async () => [stale, active],
      focus: async () => true,
      getForegroundHandle: async () => 'fresh',
    };
    const manager = new ActionManager();
    manager.registerExecutor(new WindowExecutor(provider));
    const action = await manager.execute(manager.createAction({ type: 'window.focus', parameters: { handle: 'stale' } }));

    expect(action.status).toBe('failed');
    expect(action.error?.code).toBe('VERIFICATION_FAILED');
  });

  it('matches a hosted application by its window title', async () => {
    const target: WindowInfo = { handle: 'hosted', application: 'Application Frame Host', title: 'Calculator', processId: 42, processPath: 'ApplicationFrameHost.exe', bounds: { x: 0, y: 0, width: 300, height: 300 }, visible: true };
    let foreground = 'other';
    const provider: WindowControlProvider = {
      getActive: async () => target,
      list: async () => [target],
      focus: async () => { foreground = target.handle; return true; },
      getForegroundHandle: async () => foreground,
    };
    const manager = new ActionManager();
    manager.registerExecutor(new WindowExecutor(provider));
    const action = await manager.execute(manager.createAction({ type: 'window.focus', parameters: { application: 'Calculator', title: 'Calculator' } }));

    expect(action.status).toBe('succeeded');
  });
});

