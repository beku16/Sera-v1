import { describe, expect, it } from 'vitest';
import { ActionManager } from '../actions/ActionManager';
import { ScreenExecutor } from '../actions/ScreenExecutor';
import { ScreenController, ScreenFrame, DisplayInfo } from '../actions/ControlProviders';
import { listDisplaysTool } from '../tools/tools/computerControlTools';

class DisplayController implements ScreenController {
  readonly displays: DisplayInfo[] = [
    { id: 'primary', x: 0, y: 0, width: 1920, height: 1080, isPrimary: true },
    { id: 'left', x: -1280, y: 0, width: 1280, height: 1024, isPrimary: false },
  ];
  async startSharing(): Promise<void> {}
  async stopSharing(): Promise<void> {}
  isSharing(): boolean { return true; }
  async capture(): Promise<ScreenFrame> { return { width: 1, height: 1, capturedAt: new Date().toISOString(), data: 'x' }; }
  getDisplays(): DisplayInfo[] { return this.displays; }
}

describe('display enumeration', () => {
  it('returns stable display IDs and desktop bounds', async () => {
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenExecutor(new DisplayController()));
    const action = manager.createAction({ type: 'screen.listDisplays', parameters: {} });
    const result = await manager.execute(action);

    expect(result.status).toBe('succeeded');
    expect(result.result).toEqual([
      { id: 'primary', x: 0, y: 0, width: 1920, height: 1080, isPrimary: true },
      { id: 'left', x: -1280, y: 0, width: 1280, height: 1024, isPrimary: false },
    ]);
  });

  it('rejects a display-specific inspection when capture is unavailable', async () => {
    const manager = new ActionManager();
    manager.registerExecutor(new ScreenExecutor(new DisplayController()));
    const action = manager.createAction({ type: 'screen.inspect', parameters: { displayId: 'left' } });
    const result = await manager.execute(action);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('SCREEN_PROVIDER_UNAVAILABLE');
  });

  it('declares display enumeration as read-only computer inspection', () => {
    expect(listDisplaysTool.permissionLevel).toBe('READ_ONLY');
    expect(listDisplaysTool.capability).toBe('COMPUTER_READ');
  });
});

