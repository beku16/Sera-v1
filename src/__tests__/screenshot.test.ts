import { describe, expect, it } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ScreenshotExecutor } from '../actions/ScreenshotExecutor';
import { ScreenController, ScreenFrame } from '../actions/ControlProviders';
import type { WindowControlProvider, WindowInfo } from '../actions/WindowExecutor';

class MockScreenController implements ScreenController {
  public sharing = true;
  public frame: ScreenFrame = {
    width: 1280,
    height: 720,
    capturedAt: new Date().toISOString(),
    data: 'base64-image-data',
  };
  public region: { x: number; y: number; width: number; height: number } | undefined;

  async startSharing(): Promise<void> { this.sharing = true; }
  async stopSharing(): Promise<void> { this.sharing = false; }
  isSharing(): boolean { return this.sharing; }
  async capture(): Promise<ScreenFrame> { return this.frame; }
  async captureRegion(x: number, y: number, width: number, height: number): Promise<ScreenFrame> {
    this.region = { x, y, width, height };
    return { ...this.frame, width, height };
  }
}

class MockWindowProvider implements WindowControlProvider {
  public readonly target: WindowInfo = {
    handle: '42',
    application: 'TestApp',
    title: 'Test window',
    processId: 1234,
    processPath: 'C:\\TestApp.exe',
    bounds: { x: 50, y: 80, width: 640, height: 480 },
    visible: true,
  };

  async getActive(): Promise<WindowInfo> { return this.target; }
  async list(): Promise<WindowInfo[]> { return [this.target]; }
  async focus(): Promise<boolean> { return true; }
  async getForegroundHandle(): Promise<string> { return this.target.handle; }
}

describe('ScreenshotExecutor', () => {
  it('captures and verifies a full-screen frame', async () => {
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenshotExecutor(new MockScreenController()));
    const action = manager.createAction({ type: 'screenshot.capture', parameters: { format: 'png' } });

    const result = await manager.execute(action);

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({ width: 1280, height: 720, format: 'png', data: 'base64-image-data' });
    expect(result.verification?.status).toBe('success');
  });

  it('rejects a frame without image data', async () => {
    const controller = new MockScreenController();
    controller.frame = { ...controller.frame, data: undefined };
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenshotExecutor(controller));
    const action = manager.createAction({ type: 'screenshot.capture', parameters: {} });

    const result = await manager.execute(action);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('SCREEN_CAPTURE_FAILED');
  });

  it('requires a target for window capture', async () => {
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenshotExecutor(new MockScreenController()));
    const action = manager.createAction({ type: 'screenshot.captureWindow', parameters: {} });

    const result = await manager.execute(action);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('INVALID_ARGUMENT');
  });

  it('captures the requested window bounds by handle', async () => {
    const controller = new MockScreenController();
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenshotExecutor(controller, new MockWindowProvider()));
    const action = manager.createAction({ type: 'screenshot.captureWindow', parameters: { windowHandle: 42 } });

    const result = await manager.execute(action);

    expect(result.status).toBe('succeeded');
    expect(controller.region).toEqual({ x: 50, y: 80, width: 640, height: 480 });
    expect(result.result).toMatchObject({ width: 640, height: 480, windowHandle: '42' });
  });
});
