import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { InputExecutor } from '../actions/InputExecutor';
import { ActionError } from '../actions/errors';
import { robotJsKeyName, RobotJsInputController } from '../actions/WindowsProviders';
import type { RobotApi } from '../actions/WindowsProviders';
import type { VerificationResult } from '../actions/types';

// ===========================================================================
// Why this file exists
// ---------------------------------------------------------------------------
// A user session showed three hard failures in a row:
//   1. controlComputerInput → INVALID_ARGUMENT: "Click button must be left,
//      middle, or right." (the model sent a decorated value like "left click")
//   2. controlComputerInput → INPUT_EXECUTION_FAILED: "Windows rejected the
//      key press." for enter/escape/tab — the key-name map fed robotjs the
//      X11 keysym "Return" instead of its own lowercase "enter", so every
//      named key press threw while typing still worked.
//   3. The chat copy button silently did nothing (covered by renderer code
//      + the Electron bridge; behavior is asserted indirectly here only for
//      the key paths).
// These tests pin the resilient behavior so none of it regresses.
// ===========================================================================

interface RecordedClick { button: 'left' | 'middle' | 'right'; clicks: number; x?: number; y?: number }

function makeExecutor() {
  const clicks: RecordedClick[] = [];
  const drags: Array<{ fromX: number; fromY: number; toX: number; toY: number; button: 'left' | 'middle' | 'right' }> = [];
  const controller = {
    type: async (_text: string) => undefined,
    press: async (_key: string) => undefined,
    hotkey: async (_keys: string[]) => undefined,
    click: async (button: 'left' | 'middle' | 'right', count: number, x?: number, y?: number) => {
      clicks.push({ button, clicks: count, x, y });
    },
    move: async (_x: number, _y: number) => undefined,
    scroll: async (_delta: number) => undefined,
    drag: async (fromX: number, fromY: number, toX: number, toY: number, button: 'left' | 'middle' | 'right') => {
      drags.push({ fromX, fromY, toX, toY, button });
    },
    verify: async (): Promise<VerificationResult> => ({ status: 'success' }),
  };
  const manager = new ActionManager({ logger: () => {} });
  manager.registerExecutor(new InputExecutor(controller));
  return { manager, clicks, drags };
}

async function runClick(manager: ActionManager, parameters: Record<string, unknown>): Promise<void> {
  const action = manager.createAction({ type: 'input.click', parameters });
  const outcome = await manager.execute(action);
  if (outcome.status === 'failed') throw outcome.error;
}

async function runDrag(manager: ActionManager, parameters: Record<string, unknown>): Promise<void> {
  const action = manager.createAction({ type: 'input.drag', parameters });
  const outcome = await manager.execute(action);
  if (outcome.status === 'failed') throw outcome.error;
}

describe('input.click tolerates decorated button names', () => {
  it('accepts the exact tokens it always did', async () => {
    const { manager, clicks } = makeExecutor();
    await runClick(manager, { button: 'left' });
    await runClick(manager, { button: 'right' });
    await runClick(manager, { button: 'middle' });
    expect(clicks.map((entry) => entry.button)).toEqual(['left', 'right', 'middle']);
  });

  it('normalizes case, decorations, and synonyms instead of failing', async () => {
    const { manager, clicks } = makeExecutor();
    await runClick(manager, { button: 'Left' });
    await runClick(manager, { button: 'left click' });
    await runClick(manager, { button: 'the left mouse button' });
    await runClick(manager, { button: 'SECONDARY' });
    await runClick(manager, { button: 'right-click' });
    await runClick(manager, { button: 'wheel' });
    await runClick(manager, { button: 'primary' });
    expect(clicks.map((entry) => entry.button)).toEqual(['left', 'left', 'left', 'right', 'right', 'middle', 'left']);
  });

  it('defaults to left when the button is omitted', async () => {
    const { manager, clicks } = makeExecutor();
    await runClick(manager, {});
    expect(clicks).toHaveLength(1);
    expect(clicks[0].button).toBe('left');
    expect(clicks[0].clicks).toBe(1);
  });

  it('still rejects genuinely unknown values with a helpful message', async () => {
    const { manager } = makeExecutor();
    await expect(runClick(manager, { button: 'banana' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('banana'),
    });
  });

  it('accepts numeric-string click counts ("2" = double click)', async () => {
    const { manager, clicks } = makeExecutor();
    await runClick(manager, { button: 'left', clicks: '2' });
    expect(clicks[0].clicks).toBe(2);
  });

  it('drags default to the left button when omitted', async () => {
    const { manager, drags } = makeExecutor();
    await runDrag(manager, { fromX: 10, fromY: 10, toX: 100, toY: 100 });
    expect(drags[0].button).toBe('left');
  });
});

describe('robotJsKeyName maps to the right native table per platform', () => {
  it('uses robotjs lowercase names on Windows (the regression that broke enter)', () => {
    expect(robotJsKeyName('enter', 'win32')).toBe('enter');
    expect(robotJsKeyName('escape', 'win32')).toBe('escape');
    expect(robotJsKeyName('tab', 'win32')).toBe('tab');
    expect(robotJsKeyName('backspace', 'win32')).toBe('backspace');
    expect(robotJsKeyName('pageup', 'win32')).toBe('pageup');
    expect(robotJsKeyName('pagedown', 'win32')).toBe('pagedown');
    expect(robotJsKeyName('printscreen', 'win32')).toBe('printscreen');
    // Single characters and f-keys pass through unchanged.
    expect(robotJsKeyName('a', 'win32')).toBe('a');
    expect(robotJsKeyName('5', 'win32')).toBe('5');
    expect(robotJsKeyName('f5', 'win32')).toBe('f5');
  });

  it('maps ctrl and win to names robotjs actually knows on Windows', () => {
    // "ctrl" is not in robotjs's table; "control" is.
    expect(robotJsKeyName('ctrl', 'win32')).toBe('control');
    expect(robotJsKeyName('control', 'win32')).toBe('control');
    // robotjs has no "super" — its meta key name is "command" (VK_LWIN on Windows).
    expect(robotJsKeyName('win', 'win32')).toBe('command');
    expect(robotJsKeyName('alt', 'win32')).toBe('alt');
    expect(robotJsKeyName('shift', 'win32')).toBe('shift');
  });

  it('keeps X11 keysyms on Linux for xdotool', () => {
    expect(robotJsKeyName('enter', 'linux')).toBe('Return');
    expect(robotJsKeyName('pageup', 'linux')).toBe('Page_Up');
    expect(robotJsKeyName('ctrl', 'linux')).toBe('ctrl');
    expect(robotJsKeyName('win', 'linux')).toBe('super');
  });

  it('defaults to the host platform', () => {
    const expected = process.platform === 'win32' ? 'enter' : 'Return';
    expect(robotJsKeyName('enter')).toBe(expected);
  });

  it('rejects unsupported keys with INVALID_KEY', () => {
    expect(() => robotJsKeyName('brightup', 'win32')).toThrowError(ActionError);
  });
});

// ---------------------------------------------------------------------------
// RobotJsInputController.press on Windows: mapping + retry + enter fallback
// ---------------------------------------------------------------------------

function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  return run().finally(() => {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  });
}

function makeFakeRobot(overrides: Partial<RobotApi> = {}): RobotApi {
  return {
    screen: { capture: () => ({ width: 1, height: 1, bytesPerPixel: 4, image: Buffer.alloc(4) }) },
    typeString: () => undefined,
    keyTap: () => undefined,
    moveMouse: () => undefined,
    mouseClick: () => undefined,
    mouseToggle: () => undefined,
    dragMouse: () => undefined,
    scrollMouse: () => undefined,
    getMousePos: () => ({ x: 0, y: 0 }),
    getDisplays: () => [{ id: 1, x: 0, y: 0, width: 1920, height: 1080, isMain: true }],
    ...overrides,
  } as RobotApi;
}

describe('RobotJsInputController.press on Windows', () => {
  it('sends the robotjs-native key name, not the X11 keysym', async () => {
    const robot = makeFakeRobot();
    const keyTap = vi.spyOn(robot, 'keyTap');
    const controller = new RobotJsInputController(() => robot);
    await withMockedPlatform('win32', async () => {
      await controller.press('enter');
    });
    expect(keyTap).toHaveBeenCalledWith('enter');
  });

  it('retries once when keyTap transiently fails', async () => {
    const robot = makeFakeRobot();
    let calls = 0;
    vi.spyOn(robot, 'keyTap').mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('SendInput failed');
      return undefined;
    });
    const controller = new RobotJsInputController(() => robot);
    await withMockedPlatform('win32', async () => {
      await controller.press('escape');
    });
    expect(calls).toBe(2);
  });

  it('falls back to typing a newline when the enter tap keeps failing', async () => {
    const robot = makeFakeRobot();
    vi.spyOn(robot, 'keyTap').mockImplementation(() => { throw new Error('SendInput failed'); });
    const typeString = vi.spyOn(robot, 'typeString');
    const controller = new RobotJsInputController(() => robot);
    await withMockedPlatform('win32', async () => {
      await controller.press('enter');
    });
    expect(typeString).toHaveBeenCalledWith('\n');
  });

  it('throws a descriptive INPUT_EXECUTION_FAILED after exhausting retries', async () => {
    const robot = makeFakeRobot();
    vi.spyOn(robot, 'keyTap').mockImplementation(() => { throw new Error('SendInput failed'); });
    vi.spyOn(robot, 'typeString').mockImplementation(() => { throw new Error('typeString failed'); });
    const controller = new RobotJsInputController(() => robot);
    await withMockedPlatform('win32', async () => {
      await expect(controller.press('escape')).rejects.toMatchObject({
        code: 'INPUT_EXECUTION_FAILED',
        message: expect.stringContaining('escape'),
      });
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
