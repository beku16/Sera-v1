import { describe, expect, it, vi } from 'vitest';
import { ScreenUnderstanding } from '../vision/ScreenUnderstanding';
import { ScreenFrame } from '../actions/ControlProviders';
import { WindowControlProvider, WindowInfo } from '../actions/WindowExecutor';
import { OcrProvider } from '../vision/types';
import { rawBgraFrameToPng } from '../vision/screenImage';
import { VisionExecutor } from '../vision/VisionExecutor';
import { ActionManager } from '../actions/ActionManager';

const frame: ScreenFrame = {
  width: 2,
  height: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  format: 'raw-bgra',
  bytesPerPixel: 4,
  data: Buffer.from([0, 0, 255, 255, 0, 255, 0, 255]).toString('base64'),
};

const active: WindowInfo = {
  handle: '1', application: 'Calculator', title: 'Calculator', processId: 1, processPath: 'calc.exe',
  bounds: { x: 0, y: 0, width: 2, height: 1 }, visible: true,
};

describe('screen vision layer', () => {
  it('converts raw BGRA data into a non-empty PNG without storing the source frame', () => {
    const png = rawBgraFrameToPng(frame);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.length).toBeGreaterThan(8);
  });

  it('combines active-window context and OCR into structured observations', async () => {
    const screen = { isSharing: () => true, capture: vi.fn(async () => frame) } as any;
    const windows: WindowControlProvider = { getActive: async () => active, list: async () => [active], focus: async () => true, getForegroundHandle: async () => '1' };
    const ocr: OcrProvider = { recognize: vi.fn(async () => [{ text: '625', confidence: 0.98, bbox: { x0: 10, y0: 20, x1: 40, y1: 40 } }]) };
    const understanding = new ScreenUnderstanding(screen, windows, ocr);
    const observation = await understanding.inspectScreen();

    expect(observation.application).toBe('Calculator');
    expect(observation.text).toBe('625');
    expect(observation.elements[0]).toMatchObject({ text: '625', source: 'ocr', confidence: 0.98, x: 10, y: 20 });
  });

  it('locates the highest-confidence matching element through VisionExecutor', async () => {
    const screen = { isSharing: () => true, capture: vi.fn(async () => frame) } as any;
    const windows: WindowControlProvider = { getActive: async () => active, list: async () => [active], focus: async () => true, getForegroundHandle: async () => '1' };
    const ocr: OcrProvider = { recognize: vi.fn(async () => [
      { text: '625', confidence: 0.6, bbox: { x0: 10, y0: 20, x1: 40, y1: 40 } },
      { text: '625', confidence: 0.95, bbox: { x0: 50, y0: 20, x1: 80, y1: 40 } },
    ]) };
    const manager = new ActionManager();
    manager.registerExecutor(new VisionExecutor(new ScreenUnderstanding(screen, windows, ocr)));
    const result = await manager.execute(manager.createAction({ type: 'vision.locate', parameters: { query: '625' } }));

    expect(result.status).toBe('succeeded');
    expect(result.result).toMatchObject({ confidence: 0.95, x: 50 });
  });

  it('rejects a matching element below the confidence threshold', async () => {
    const screen = { isSharing: () => true, capture: vi.fn(async () => frame) } as any;
    const windows: WindowControlProvider = { getActive: async () => active, list: async () => [active], focus: async () => true, getForegroundHandle: async () => '1' };
    const ocr: OcrProvider = { recognize: vi.fn(async () => [{ text: '625', confidence: 0.4, bbox: { x0: 10, y0: 20, x1: 40, y1: 40 } }]) };
    const understanding = new ScreenUnderstanding(screen, windows, ocr);

    expect(await understanding.locateElement('625')).toBeNull();
  });

  it('captures a requested screen region', async () => {
    const regionalFrame = { ...frame, width: 1, height: 1 };
    const screen = { isSharing: () => true, capture: vi.fn(async () => frame), captureRegion: vi.fn(async () => regionalFrame) } as any;
    const windows: WindowControlProvider = { getActive: async () => active, list: async () => [active], focus: async () => true, getForegroundHandle: async () => '1' };
    const ocr: OcrProvider = { recognize: vi.fn(async () => []) };
    const observation = await new ScreenUnderstanding(screen, windows, ocr).inspectScreen({ x: 1, y: 2, width: 3, height: 4 });

    expect(screen.captureRegion).toHaveBeenCalledWith(1, 2, 3, 4);
    expect(observation.frame.width).toBe(1);
  });

  it('maps regional OCR coordinates into desktop coordinates', async () => {
    const regionalFrame = { ...frame, originX: 100, originY: 200, scaleX: 2, scaleY: 2 };
    const screen = { isSharing: () => true, capture: vi.fn(async () => regionalFrame) } as any;
    const windows: WindowControlProvider = { getActive: async () => active, list: async () => [active], focus: async () => true, getForegroundHandle: async () => '1' };
    const ocr: OcrProvider = { recognize: vi.fn(async () => [{ text: 'target', confidence: 0.9, bbox: { x0: 10, y0: 15, x1: 20, y1: 25 } }]) };

    const observation = await new ScreenUnderstanding(screen, windows, ocr).inspectScreen();

    expect(observation.elements[0]).toMatchObject({ x: 120, y: 230, width: 20, height: 20 });
  });
});
