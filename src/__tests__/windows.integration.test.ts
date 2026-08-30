import { afterEach, describe, expect, it } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { InputExecutor } from '../actions/InputExecutor';
import { ScreenExecutor } from '../actions/ScreenExecutor';
import { RobotJsInputController, RobotJsScreenController } from '../actions/WindowsProviders';
import { WindowExecutor } from '../actions/WindowExecutor';
import { WindowsWindowProvider } from '../actions/WindowExecutor';

/**
 * Robotjs is a Windows-only native module that fails to load on Linux/macOS
 * because of missing libXtst.so.6 / X11 dev headers. We previously imported it
 * at the top of this file, which crashed the entire test suite import graph
 * — affecting totally unrelated test files. Resolve it lazily so the suite
 * is importable everywhere, and is skipped (not crashed) when robotjs is
 * unavailable.
 */
let robot: typeof import('robotjs') | null = null;
try {
  // Top-level require is gated behind platform + try/catch so it never throws.
  if (process.platform === 'win32') robot = require('robotjs');
} catch { /* robotjs unavailable on this host; tests below will be skipped */ }

const enabled = process.platform === 'win32' && !!robot && process.env.SERA_RUN_WINDOWS_INTEGRATION === '1';
const describeWindows = enabled ? describe : describe.skip;
let originalPosition = robot ? robot.getMousePos() : { x: 0, y: 0 };

afterEach(() => {
  if (!robot) return;
  robot.moveMouse(originalPosition.x, originalPosition.y);
});

describeWindows('real Windows input and screen integration', () => {
  it('moves the cursor through ActionManager and verifies the result', async () => {
    originalPosition = robot!.getMousePos();
    const manager = new ActionManager({ logger: () => {} });
    manager.registerExecutor(new InputExecutor(new RobotJsInputController()));
    const action = await manager.execute(manager.createAction({ type: 'input.move', parameters: { x: 100, y: 100 } }));

    expect(action.status).toBe('succeeded');
    const finalPos = robot!.getMousePos();
    const xDiff = Math.abs(finalPos.x - 100);
    const yDiff = Math.abs(finalPos.y - 100);
    const maxTolerance = 20;
    expect(xDiff).toBeLessThanOrEqual(maxTolerance);
    expect(yDiff).toBeLessThanOrEqual(maxTolerance);
  });

  it('starts sharing, captures a real frame, and releases sharing', async () => {
    const screen = new RobotJsScreenController();
    const manager = new ActionManager({ logger: () => {} });
    manager.registerExecutor(new ScreenExecutor(screen));
    const start = await manager.execute(manager.createAction({ type: 'screen.startSharing', parameters: {} }));
    const capture = await manager.execute(manager.createAction({ type: 'screen.inspect', parameters: {} }));
    await screen.stopSharing();

    expect(start.status).toBe('succeeded');
    expect(capture.status).toBe('succeeded');
    expect(capture.result).toMatchObject({ width: expect.any(Number), height: expect.any(Number), format: 'raw-bgra' });
    expect(screen.isSharing()).toBe(false);
  });

  it('gets, enumerates, focuses, and verifies a real foreground window', async () => {
    const provider = new WindowsWindowProvider();
    const windows = await provider.list();
    expect(windows.length).toBeGreaterThan(0);
    const target = windows.find((windowInfo) => /Visual Studio Code|Google Chrome|Microsoft Edge/i.test(windowInfo.application));
    expect(target).toBeDefined();
    if (!target) return;

    const manager = new ActionManager({ logger: () => {} });
    manager.registerExecutor(new WindowExecutor(provider));
    const focus = await manager.execute(manager.createAction({
      type: 'window.focus',
      parameters: { handle: target.handle },
    }));

    expect(focus.status).toBe('succeeded');
    expect(focus.verification?.status).toBe('success');
  });

  it('minimizes, maximizes, and restores a real window through ActionManager', async () => {
    const provider = new WindowsWindowProvider();
    const windows = await provider.list();
    const target = windows.find((windowInfo) => /Visual Studio Code|Google Chrome|Microsoft Edge/i.test(windowInfo.application) && windowInfo.bounds.width > 300 && windowInfo.bounds.height > 200);
    expect(target).toBeDefined();
    if (!target) return;

    const manager = new ActionManager({ logger: () => {} });
    manager.registerExecutor(new WindowExecutor(provider));
    for (const operation of ['minimize', 'maximize', 'restore'] as const) {
      const action = await manager.execute(manager.createAction({ type: `window.${operation}`, parameters: { handle: target.handle } }));
      expect(action.status).toBe('succeeded');
      expect(action.verification?.status).toBe('success');
    }
  });
});
